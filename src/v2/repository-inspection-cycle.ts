import { inspectSource, inspectionInstructions } from './repository-inspector.ts';
import type { InspectionInput, Review } from './repository-inspector.ts';
import { openRemoteRepository, SourceError, parseRepositoryUrl } from './repository-source.ts';
import { recommendRepositoryAction } from './repository-policy.ts';
import { createHash } from 'node:crypto';

/** Fetch and inspect public source; provider failures become unresolved findings and preserve HOLD. */
export async function runRepositoryInspection(
  url: string,
  requestedAction: string,
  options: { fetcher?: typeof fetch; review?: (input: InspectionInput) => Promise<Review> } = {},
) {
  const repository = parseRepositoryUrl(url); // invalid targets never reach the network
  if (!requestedAction.trim()) {
    throw new Error('Requested action is required.');
  }
  const started = Date.now();
  let inspection: Awaited<ReturnType<typeof inspectSource>>;
  try {
    const source = await openRemoteRepository(repository.artifact, options.fetcher);
    inspection = await inspectSource(source, requestedAction, options.review);
  } catch (error) {
    const reason =
      error instanceof SourceError ? error.code : 'provider_unavailable_or_invalid_response';
    inspection = {
      check: 'repository_inspection',
      artifact: repository.artifact,
      outcome: 'unresolved',
      finding: `Repository source unavailable: ${reason}.`,
      scope: {
        requested_action: requestedAction,
        artifact_revision: 'unresolved',
        inspected_files: [],
        findings: [],
        gaps: [reason],
      },
      source_errors: [
        {
          file: '(repository)',
          code: reason,
          retry_at: error instanceof SourceError ? error.retryAt : null,
        },
      ],
      unavailable_files: [],
      file_hashes: [],
      review_status: 'automated_assessment_not_ground_truth',
      limitations: 'Unavailable source does not establish malicious intent.',
      review_errors: [],
      citation_adjustments: [],
      model_calls: 0,
      duration_ms: Date.now() - started,
    };
  }
  const recommendation = recommendRepositoryAction({
    executionRequested: true,
    inspection: inspection.outcome,
    assessmentAuthorisation: 'unresolved',
  });
  return {
    schema_version: 1,
    created_at: new Date().toISOString(),
    purpose: 'live_read_only_repository_inspection',
    model: process.env.V2_ANNOTATION_MODEL ?? 'gpt-5.6-luna',
    prompt_sha256: createHash('sha256').update(inspectionInstructions).digest('hex'),
    inspection,
    recommendation,
    manual_review: {
      candidate: inspection.outcome === 'unresolved',
      estimated_minutes: 30,
      estimate_basis: 'user_assumption_not_measured',
      economic_value: 'unknown_no_review_outcome_likelihoods_or_effort_cost_conversion',
      reason:
        inspection.outcome === 'unresolved'
          ? 'Review could identify harmful behaviour and change HOLD to FLAG; clean review alone cannot resolve authorisation.'
          : 'Automated inspection returned an outcome; unresolved authorisation is a separate check.',
    },
    // No source checkout or temporary files exist; only the report is retained.
    source_storage: 'memory_only_no_checkout',
    duration_ms: Date.now() - started,
    belief_update: 'not_applied_no_real_inspection_likelihoods_configured',
  };
}
