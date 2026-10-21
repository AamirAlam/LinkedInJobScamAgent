import { createHash } from 'node:crypto';
import { z } from 'zod';
import { repositoryInspectionSchema } from './repository-replay.ts';
import { recommendRepositoryAction } from './repository-policy.ts';
import { validateSourcePath } from './repository-source.ts';

const fileHashSchema = z.object({
  file: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const sourceSchema = z.object({
  purpose: z.literal('live_read_only_repository_inspection'),
  inspection: repositoryInspectionSchema,
});
const supplementSchema = z.object({
  schema_version: z.literal(1),
  purpose: z.literal('automated_repository_supplement'),
  original_report_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  coverage: z.literal('listed_files_only'),
  inspection: repositoryInspectionSchema,
  file_hashes: z.array(fileHashSchema).min(1),
  observations: z.array(
    z.object({
      file: z.string().min(1),
      start_line: z.number().int().positive(),
      end_line: z.number().int().positive(),
      assessment: z.string().trim().min(1),
    }),
  ),
});

function validateInventory(
  files: readonly string[],
  hashes: readonly z.infer<typeof fileHashSchema>[],
): void {
  files.forEach(validateSourcePath);
  if (
    new Set(files).size !== files.length ||
    new Set(hashes.map((item) => item.file)).size !== hashes.length ||
    hashes.length !== files.length ||
    hashes.some((item) => !files.includes(item.file))
  ) {
    throw new Error('File hash inventory must match inspected files exactly once.');
  }
}

/** Apply a recorded automated subset review; broader coverage gaps and prior harm remain. */
export function applyAutomatedSupplement(
  rawSupplement: string,
  rawSource: string,
  sourcePath: string,
) {
  const supplement = supplementSchema.parse(JSON.parse(rawSupplement));
  const rawOriginal: unknown = JSON.parse(rawSource);
  const original = sourceSchema.parse(rawOriginal).inspection;
  const originalHashes = z
    .object({ inspection: z.object({ file_hashes: z.array(fileHashSchema) }) })
    .parse(rawOriginal).inspection.file_hashes;
  const before = original.scope;
  const added = supplement.inspection.scope;
  const sourceHash = createHash('sha256').update(rawSource).digest('hex');
  if (
    !before ||
    !added ||
    before.inspection_boundary !== 'repository_controlled_code' ||
    added.inspection_boundary !== before.inspection_boundary ||
    !/^[a-f0-9]{40,64}$/.test(before.artifact_revision) ||
    added.artifact_revision !== before.artifact_revision ||
    added.requested_action !== before.requested_action ||
    supplement.inspection.artifact !== original.artifact ||
    supplement.original_report_sha256 !== sourceHash
  ) {
    throw new Error(
      'Supplement must match original hash, artifact, pinned revision, action and boundary.',
    );
  }
  validateInventory(before.inspected_files, originalHashes);
  validateInventory(added.inspected_files, supplement.file_hashes);
  for (const item of supplement.file_hashes) {
    const previous = originalHashes.find((file) => file.file === item.file);
    if (previous && previous.sha256 !== item.sha256) {
      throw new Error('Overlapping file hashes must match.');
    }
    if (!supplement.observations.some((observation) => observation.file === item.file)) {
      throw new Error('Every supplemental file requires a recorded observation.');
    }
  }
  for (const observation of supplement.observations) {
    if (
      !added.inspected_files.includes(observation.file) ||
      observation.end_line < observation.start_line
    ) {
      throw new Error('Observations must reference supplemental files with valid line ranges.');
    }
  }
  const canResolveNamedFiles =
    supplement.inspection.outcome !== 'unresolved' && added.gaps.length === 0;
  const resolvedGaps = before.gaps.filter(
    (gap) =>
      canResolveNamedFiles &&
      added.inspected_files.some(
        (file) =>
          gap === `Uninspected local path: ${file}.` ||
          gap.startsWith(`Unjustified in-scope file request: ${file}. `),
      ),
  );
  const gaps = [
    ...new Set([
      ...before.gaps.filter((gap) => !resolvedGaps.includes(gap)),
      ...added.gaps,
      ...(original.outcome === 'unresolved' && !before.gaps.length
        ? ['Original unresolved coverage requires explicit review.']
        : []),
    ]),
  ];
  const findings = [
    ...new Map(
      [...before.findings, ...added.findings].map((finding) => [JSON.stringify(finding), finding]),
    ).values(),
  ];
  const harmful =
    original.outcome === 'harmful_behaviour_found' || findings.some((finding) => finding.harmful);
  const inspection = repositoryInspectionSchema.parse({
    check: 'repository_inspection',
    artifact: original.artifact,
    outcome: harmful
      ? 'harmful_behaviour_found'
      : gaps.length
        ? 'unresolved'
        : 'no_harmful_behaviour_found',
    finding:
      'Combined recorded automated source assessments; listed-file supplement does not establish broader execution-path coverage.',
    scope: {
      ...before,
      inspected_files: [...new Set([...before.inspected_files, ...added.inspected_files])],
      findings,
      gaps,
    },
    limitations:
      'Recorded automated attestations. Hash relationships and coverage inventories are validated; source bytes, model interpretation and reviewer identity are not independently authenticated. Dependencies and recruiter authorisation remain unverified.',
  });
  const assessment = {
    executionRequested: true,
    inspection: inspection.outcome,
    assessmentAuthorisation: 'unresolved' as const,
  };
  return {
    schema_version: 1,
    purpose: 'automated_supplement_assessment' as const,
    created_at: new Date().toISOString(),
    source_report: sourcePath,
    source_report_sha256: sourceHash,
    supplement_sha256: createHash('sha256').update(rawSupplement).digest('hex'),
    original_scope: before,
    supplemental_scope: added,
    resolved_named_gaps: resolvedGaps,
    inspection,
    file_hashes: [
      ...originalHashes,
      ...supplement.file_hashes.filter((item) => !before.inspected_files.includes(item.file)),
    ],
    observations: supplement.observations,
    assessment,
    recommendation: recommendRepositoryAction(assessment),
    human_review_status: 'not_performed',
    belief_update: 'not_applied_no_followup_likelihoods_configured',
  };
}
