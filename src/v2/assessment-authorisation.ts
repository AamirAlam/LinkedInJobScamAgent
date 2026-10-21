import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { readInspectionReport } from './manual-review.ts';
import { recommendRepositoryAction } from './repository-policy.ts';
import { parseRepositoryUrl } from './repository-source.ts';

const nonempty = z.string().trim().min(1);
const completedSchema = z.object({
  schema_version: z.literal(1),
  purpose: z.literal('assessment_authorisation_record'),
  status: z.literal('completed_verification'),
  source_report_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  binding: z.unknown(),
  outcome: z.enum(['verified', 'unresolved']),
  verification: z.object({
    reviewer: nonempty,
    reviewed_at: z.string().datetime({ offset: true }),
    organisation: nonempty,
    requester: nonempty,
    independent_channel: z.enum(['independent_company_contact', 'company_controlled_confirmation']),
    evidence_reference: nonempty,
    evidence_summary: nonempty,
    identity_confirmed: z.boolean(),
    authority_confirmed: z.boolean(),
    action_confirmed: z.boolean(),
  }),
});

function readBoundInspection(rawSource: string) {
  const inspection = readInspectionReport(rawSource);
  const scope = inspection.scope;
  if (
    !scope ||
    scope.inspection_boundary !== 'repository_controlled_code' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(scope.artifact_revision)
  ) {
    throw new Error('Authorisation requires a pinned repository-controlled-code inspection.');
  }
  const repository = parseRepositoryUrl(inspection.artifact);
  if (repository.artifact !== inspection.artifact) {
    throw new Error('Inspection artifact must be canonical.');
  }
  return {
    inspection,
    binding: {
      artifact: inspection.artifact,
      revision: scope.artifact_revision,
      requested_action: scope.requested_action,
      inspection_boundary: scope.inspection_boundary,
    },
    sourceHash: createHash('sha256').update(rawSource).digest('hex'),
  };
}

/** Prepare blank independent-verification evidence; source inspection cannot grant authorisation. */
export function prepareAssessmentAuthorisation(rawSource: string, sourcePath: string) {
  const { binding, sourceHash } = readBoundInspection(rawSource);
  return {
    schema_version: 1,
    purpose: 'assessment_authorisation_record',
    status: 'pending_verification',
    created_at: new Date().toISOString(),
    source_report: sourcePath,
    source_report_sha256: sourceHash,
    binding,
    outcome: 'unresolved',
    instructions: [
      'Use an independently obtained company contact or company-controlled confirmation, not the requester profile or supplied claim alone.',
      'Confirm the requester identity, their authority to arrange this assessment, and this exact repository/revision/action. Record the source and what it confirmed.',
      'Do not copy credentials or private personal data into evidence. An evidence reference may point to a separately retained record.',
      'Complete reviewer and evidence fields. Set outcome to verified only when all three confirmations are true; otherwise keep unresolved.',
      'Set status to completed_verification only after checking. Applying the record does not execute code or authenticate the reviewer.',
    ],
    verification: {
      reviewer: '',
      reviewed_at: null,
      organisation: '',
      requester: '',
      independent_channel: null,
      evidence_reference: '',
      evidence_summary: '',
      identity_confirmed: false,
      authority_confirmed: false,
      action_confirmed: false,
    },
    policy_effect: 'none_pending_verification',
  };
}

/** Apply recorded human-attested verification to the same scope; never override inspection harm. */
export function applyAssessmentAuthorisation(
  rawRecord: string,
  rawSource: string,
  sourcePath: string,
) {
  const record = completedSchema.parse(JSON.parse(rawRecord));
  const { inspection, binding, sourceHash } = readBoundInspection(rawSource);
  if (record.source_report_sha256 !== sourceHash || !isDeepStrictEqual(record.binding, binding)) {
    throw new Error(
      'Authorisation must match the exact source report, repository, revision and action.',
    );
  }
  if (Date.parse(record.verification.reviewed_at) > Date.now()) {
    throw new Error('Verification time cannot be in the future.');
  }
  const verification = record.verification;
  if (
    record.outcome === 'verified' &&
    (!verification.identity_confirmed ||
      !verification.authority_confirmed ||
      !verification.action_confirmed)
  ) {
    throw new Error(
      'Verified authorisation requires identity, authority and exact-action confirmation.',
    );
  }
  const assessment = {
    executionRequested: true,
    inspection: inspection.outcome,
    assessmentAuthorisation: record.outcome,
  };
  return {
    schema_version: 1,
    purpose: 'assessment_authorisation_assessment',
    created_at: new Date().toISOString(),
    source_report: sourcePath,
    source_report_sha256: sourceHash,
    submitted_record_sha256: createHash('sha256').update(rawRecord).digest('hex'),
    binding,
    verification,
    inspection,
    assessment,
    recommendation: recommendRepositoryAction(assessment),
    belief_update: 'not_applied_no_authorisation_likelihoods_configured',
    limitations:
      'Human-attested evidence; record structure and binding are validated, not reviewer identity or evidence authenticity. No source refresh, execution, dependency verification, dataset relabelling or automatic conversation resume. Changed artifacts and new requests need new checks.',
  };
}
