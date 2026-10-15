import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { prepareManualReview, manualCitationSchema } from './manual-review.ts';
import { recommendRepositoryAction } from './repository-policy.ts';
import { validateSourcePath } from './repository-source.ts';

const nonemptyText = z.string().trim().min(1);
const completedReviewSchema = z.object({
  schema_version: z.literal(1),
  purpose: z.literal('repository_manual_review_handoff'),
  status: z.literal('completed_human_review'),
  source_report_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  artifact: nonemptyText,
  scope: z.unknown(),
  gap_reviews: z.array(
    z.object({
      gap: nonemptyText,
      status: z.enum(['resolved', 'unresolved']),
      evidence: z.array(manualCitationSchema),
      reviewer_note: nonemptyText,
    }),
  ),
  finding_reviews: z.array(
    z.object({
      finding: z.unknown(),
      status: z.enum(['supported', 'disputed', 'unresolved']),
      evidence: z.array(manualCitationSchema),
      reviewer_note: nonemptyText,
    }),
  ),
  human_review: z.object({
    reviewer: nonemptyText,
    reviewed_at: z.string().datetime({ offset: true }),
    elapsed_minutes: z.number().finite().nonnegative(),
    revision_confirmed: z.boolean(),
    outcome: z.enum(['unresolved', 'no_harmful_behaviour_found', 'harmful_behaviour_found']),
    inspected_files: z.array(nonemptyText),
    findings: z.array(manualCitationSchema.extend({ harmful: z.boolean() })),
    remaining_gaps: z.array(nonemptyText),
    conclusion: nonemptyText,
  }),
});
type CompletedReview = z.infer<typeof completedReviewSchema>;

function validateReviewCoverage(review: CompletedReview): void {
  const human = review.human_review;
  const citations = [
    ...review.gap_reviews.flatMap((item) => item.evidence),
    ...review.finding_reviews.flatMap((item) => item.evidence),
    ...human.findings,
  ];
  for (const file of human.inspected_files) {
    validateSourcePath(file);
  }
  for (const citation of citations) {
    validateSourcePath(citation.file);
    if (citation.end_line < citation.start_line || !human.inspected_files.includes(citation.file)) {
      throw new Error('Review citations require a human-inspected file and valid line range.');
    }
  }
  for (const item of review.gap_reviews) {
    if (item.status === 'resolved' && !item.evidence.length) {
      throw new Error('Resolved gaps require cited source evidence.');
    }
    if (item.status === 'unresolved' && !human.remaining_gaps.includes(item.gap)) {
      throw new Error('Unresolved original gaps must remain in remaining_gaps.');
    }
  }
  for (const item of review.finding_reviews) {
    if (item.status !== 'unresolved' && !item.evidence.length) {
      throw new Error('Supported or disputed findings require cited source evidence.');
    }
  }
  if (human.outcome === 'unresolved' && !human.remaining_gaps.length) {
    throw new Error('An unresolved review must explain what remains unresolved.');
  }
  const harmful = human.findings.some((finding) => finding.harmful);
  if ((human.outcome === 'harmful_behaviour_found') !== harmful) {
    throw new Error('Human harmful outcome must match cited human findings.');
  }
  if (
    human.outcome !== 'unresolved' &&
    (!human.revision_confirmed || !human.inspected_files.length)
  ) {
    throw new Error('A resolved review requires a confirmed revision and inspected source files.');
  }
  if (
    human.outcome === 'no_harmful_behaviour_found' &&
    (human.remaining_gaps.length ||
      review.gap_reviews.some((item) => item.status !== 'resolved') ||
      review.finding_reviews.some((item) => item.status === 'unresolved'))
  ) {
    throw new Error('Scoped clean requires every original item addressed and no remaining gaps.');
  }
}

/** Validate human-attested evidence against the saved scope, then produce a separate assessment. */
export function applyManualReview(rawReview: string, rawSource: string, sourcePath: string) {
  const review = completedReviewSchema.parse(JSON.parse(rawReview));
  const original = prepareManualReview(rawSource, sourcePath);
  if (
    review.source_report_sha256 !== original.source_report_sha256 ||
    review.artifact !== original.artifact ||
    !isDeepStrictEqual(review.scope, original.scope)
  ) {
    throw new Error(
      'Review must match the original report hash, artifact, revision, and requested scope.',
    );
  }
  // Preserve original item order and identity: omission or duplication must not clear a blocker.
  if (
    !isDeepStrictEqual(
      review.gap_reviews.map((item) => item.gap),
      original.scope.gaps,
    ) ||
    !isDeepStrictEqual(
      review.finding_reviews.map((item) => item.finding),
      original.scope.findings,
    )
  ) {
    throw new Error('Review must address every original gap and finding exactly once, in order.');
  }
  if (
    original.scope.artifact_revision === 'unresolved' &&
    review.human_review.outcome !== 'unresolved'
  ) {
    throw new Error(
      'The source revision was unavailable; obtain a new pinned inspection before resolving it.',
    );
  }
  validateReviewCoverage(review);
  // A later review cannot silently erase previously observed harm. A disputed FLAG
  // needs a separate adjudication workflow, not the ordinary unresolved-review path.
  const effectiveOutcome =
    original.automated_outcome === 'harmful_behaviour_found'
      ? 'harmful_behaviour_found'
      : review.human_review.outcome;
  const assessment = {
    executionRequested: true,
    inspection: effectiveOutcome,
    assessmentAuthorisation: 'unresolved' as const,
  };
  return {
    schema_version: 1,
    purpose: 'repository_manual_review_assessment',
    created_at: new Date().toISOString(),
    source_report: sourcePath,
    source_report_sha256: original.source_report_sha256,
    submitted_review_sha256: createHash('sha256').update(rawReview).digest('hex'),
    artifact: original.artifact,
    original_scope: original.scope,
    reviewed_items: { gaps: review.gap_reviews, findings: review.finding_reviews },
    human_review: review.human_review,
    assessment,
    recommendation: recommendRepositoryAction(assessment),
    prior_harm_preserved: original.automated_outcome === 'harmful_behaviour_found',
    belief_update: 'not_applied_no_manual_review_likelihoods_configured',
    limitations:
      'Human-attested source review; citations are structurally validated, not independently fetched or verified. Reviewer identity is recorded, not authenticated. This record does not establish recruiter authorisation or update dataset labels.',
  };
}
