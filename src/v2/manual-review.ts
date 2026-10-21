import { createHash } from 'node:crypto';
import { z } from 'zod';
import { repositoryInspectionSchema } from './repository-replay.ts';

export const manualCitationSchema = z.object({
  file: z.string().trim().min(1),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  quote: z.string().trim().min(1),
  reason: z.string().trim().min(1),
});
export type ManualCitation = z.infer<typeof manualCitationSchema>;

const reportSchema = z.discriminatedUnion('purpose', [
  z.object({
    purpose: z.enum([
      'live_read_only_repository_inspection',
      'automated_supplement_assessment',
      'automated_execution_path_audit',
    ]),
    inspection: z.unknown(),
  }),
  z.object({
    purpose: z.literal('conversation_driven_repository_inspection'),
    status: z.literal('complete'),
    steps: z.array(z.object({ inspection: z.unknown().optional() })),
  }),
]);

/** Read a standalone or single completed conversation inspection; validates metadata, not source truth. */
export function readInspectionReport(rawReport: string) {
  const report = reportSchema.parse(JSON.parse(rawReport));
  if ('inspection' in report) {
    return repositoryInspectionSchema.parse(report.inspection);
  }
  const inspections = report.steps.flatMap((step) =>
    step.inspection === undefined ? [] : [step.inspection],
  );
  if (inspections.length !== 1) {
    throw new Error('Manual review requires exactly one inspection; select a standalone report.');
  }
  const cycle = reportSchema.options[0].parse(inspections[0]);
  return repositoryInspectionSchema.parse(cycle.inspection);
}

/** Prepare an unfilled human review record; never infer a verdict or change policy state. */
export function prepareManualReview(rawReport: string, sourceReport: string) {
  const inspection = readInspectionReport(rawReport);
  if (!inspection.scope) {
    throw new Error('Manual review requires an inspection scope and revision record.');
  }
  const scope = inspection.scope;
  return {
    schema_version: 1,
    purpose: 'repository_manual_review_handoff',
    created_at: new Date().toISOString(),
    status: 'pending_human_review',
    source_report: sourceReport,
    source_report_sha256: createHash('sha256').update(rawReport).digest('hex'),
    artifact: inspection.artifact,
    scope,
    automated_outcome: inspection.outcome,
    automated_finding: inspection.finding,
    limitations: inspection.limitations ?? null,
    instructions: [
      'Inspect source as text only. Do not run the repository, install its dependencies, or fetch executable payloads.',
      'Confirm the artifact revision and requested action before reviewing. Changed revisions need a separate assessment.',
      'Record the source path, exact lines or quote, and reasoning for each resolved gap or disputed finding.',
      'Keep unavailable or inconclusive evidence unresolved. No harmful behaviour found does not establish recruiter authorisation.',
      'Record actual review time. The earlier 30-minute estimate was an assumption, not a measurement.',
      'Each evidence item needs file, start_line, end_line, quote, and reason. List every cited file in human_review.inspected_files.',
      'Use resolved/unresolved for gap status and supported/disputed/unresolved for finding status. Preserve original items and their order.',
      'Add human_review.findings with the same citation fields plus harmful. Complete all reviewer fields and set status to completed_human_review only after reviewing.',
    ],
    gap_reviews: scope.gaps.map((gap) => ({
      gap,
      status: 'pending',
      evidence: [] as ManualCitation[],
      reviewer_note: '',
    })),
    finding_reviews: scope.findings.map((finding) => ({
      finding,
      status: 'pending',
      evidence: [] as ManualCitation[],
      reviewer_note: '',
    })),
    human_review: {
      reviewer: null,
      reviewed_at: null,
      elapsed_minutes: null,
      revision_confirmed: false,
      outcome: null,
      inspected_files: [] as string[],
      findings: [] as Array<ManualCitation & { harmful: boolean }>,
      remaining_gaps: [] as string[],
      conclusion: '',
    },
    policy_effect: 'none_handoff_only',
    belief_update: 'none_no_manual_review_likelihoods_configured',
    authorisation_status: 'unresolved_not_established_by_source_inspection',
  };
}
