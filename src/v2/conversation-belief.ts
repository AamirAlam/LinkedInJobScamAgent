import { z } from 'zod';
import { applyEvidence, calculateBinaryEntropy } from './bayes.ts';
import type { BeliefState } from './bayes.ts';
import { ordinaryHiringCosts, recommendOrdinaryHiringAction } from './decision-policy.ts';
import type { Action } from './decision-cost.ts';

const probabilitySchema = z.number().finite().min(0).max(1);
const actionSchema = z.enum(['SAFE', 'HOLD', 'FLAG']);
const likelihoodSchema = z
  .object({
    likelihoodGivenScam: probabilitySchema,
    likelihoodGivenLegitimate: probabilitySchema,
  })
  .strict();

const configSchema = z
  .object({
    schema_version: z.literal(1),
    purpose: z.literal('repository_conversation_belief'),
    priorScam: probabilitySchema,
    executionLikelihoods: likelihoodSchema,
    // Conditional on an execution request, for the FIRST inspection only.
    firstInspectionLikelihoods: z
      .object({
        'repository_inspection:unresolved': likelihoodSchema.optional(),
        'repository_inspection:no_harmful_behaviour_found': likelihoodSchema.optional(),
        'repository_inspection:harmful_behaviour_found': likelihoodSchema.optional(),
      })
      .strict(),
    provenance: z
      .object({
        kind: z.enum(['synthetic', 'assumed', 'measured']),
        source: z.string().trim().min(1),
        limitations: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((config, context) => {
    const rows = Object.values(config.firstInspectionLikelihoods).filter(
      (row): row is z.infer<typeof likelihoodSchema> => row !== undefined,
    );
    for (const group of ['likelihoodGivenScam', 'likelihoodGivenLegitimate'] as const) {
      const total = rows.reduce((sum, row) => sum + row[group], 0);
      if (total > 1 + 1e-9 || (rows.length === 3 && Math.abs(total - 1) > 1e-9)) {
        context.addIssue({
          code: 'custom',
          message:
            'First-inspection outcomes cannot exceed one within each state; complete models must sum to one.',
        });
      }
    }
  });

/** Validate explicit model inputs and provenance declarations, not the truth of their estimates. */
export function parseConversationBeliefConfig(input: unknown) {
  return configSchema.parse(input);
}

type Observation = {
  readonly time: string;
  readonly action: string;
  readonly scope: string;
  readonly reason: string;
  readonly inspection_triggered: boolean;
  readonly candidate_recorded?: boolean;
  readonly annotation?: { readonly status: string };
  readonly wallet_annotation?: { readonly status: string } | null;
  readonly inspection?: { readonly inspection: { readonly outcome: string } };
  readonly authorisation_status?: string;
  readonly artifact?: string;
};

/** Track only configured evidence; the model never supplies numerical probabilities or costs. */
export function createConversationBeliefTracker(input: unknown) {
  const config = parseConversationBeliefConfig(input);
  let belief: BeliefState = { scamProbability: config.priorScam, appliedEvidenceIds: [] };
  let lastUpdatedAtEvent: string | null = null;
  let unmodelledEvidenceEventIds: readonly string[] = [];
  let inspectionSeen = false;
  let lastAction: Action | undefined;
  return <Step extends Observation>(step: Step) => {
    let updateStatus = step.candidate_recorded
      ? 'candidate_context_only'
      : 'no_new_modelled_evidence';
    const evidenceId = `${step.time}:repository_inspection`;
    if (step.annotation?.status === 'present') {
      const update = applyEvidence(
        belief,
        'conversation:execution-request',
        config.executionLikelihoods,
      );
      belief = update.state;
      updateStatus = update.status;
    }
    if (step.inspection) {
      const outcome = step.inspection.inspection.outcome;
      const key = `repository_inspection:${outcome}`;
      const likelihoods = Object.entries(config.firstInspectionLikelihoods).find(
        ([name]) => name === key,
      )?.[1];
      if (
        !inspectionSeen &&
        belief.appliedEvidenceIds.includes('conversation:execution-request') &&
        likelihoods
      ) {
        const update = applyEvidence(belief, `${key}:${step.artifact}`, likelihoods);
        belief = update.state;
        updateStatus = update.status;
      } else {
        updateStatus = 'unmodelled_evidence';
        unmodelledEvidenceEventIds = [...new Set([...unmodelledEvidenceEventIds, evidenceId])];
      }
      inspectionSeen = true;
    }
    if (
      !step.candidate_recorded &&
      step.wallet_annotation &&
      step.wallet_annotation.status !== 'absent_so_far'
    ) {
      unmodelledEvidenceEventIds = [
        ...new Set([...unmodelledEvidenceEventIds, `${step.time}:wallet_request`]),
      ];
      updateStatus = 'unmodelled_evidence';
    }
    if (step.authorisation_status && step.authorisation_status !== 'not_supplied') {
      unmodelledEvidenceEventIds = [
        ...new Set([...unmodelledEvidenceEventIds, `${step.time}:assessment_authorisation`]),
      ];
    }
    if (updateStatus === 'updated') {
      lastUpdatedAtEvent = step.inspection ? evidenceId : `${step.time}:execution_request`;
    }
    if (updateStatus === 'unsupported_evidence') {
      unmodelledEvidenceEventIds = [
        ...new Set([
          ...unmodelledEvidenceEventIds,
          step.inspection ? evidenceId : `${step.time}:execution_request`,
        ]),
      ];
    }
    const calculation = recommendOrdinaryHiringAction(belief.scamProbability);
    const safetyAction = actionSchema.parse(step.action);
    // Immediate inspection HOLD and wallet permissions retain their existing safety contract.
    const costConstrainedAction =
      safetyAction === 'FLAG'
        ? 'FLAG'
        : step.scope === 'wallet_approval' || step.inspection_triggered
          ? safetyAction
          : calculation.costAction === 'SAFE' && safetyAction === 'HOLD'
            ? 'HOLD'
            : calculation.costAction;
    const action = step.candidate_recorded ? (lastAction ?? safetyAction) : costConstrainedAction;
    if (!step.candidate_recorded) {
      lastAction = action;
    }
    return {
      ...step,
      action,
      reason:
        action === step.action || step.candidate_recorded
          ? step.reason
          : `Configured ordinary-hiring costs select ${action} from the last modelled belief. This is not proof of fraud or legitimacy. ${step.reason}`,
      probabilistic: {
        belief,
        distribution: { scam: belief.scamProbability, legitimate: 1 - belief.scamProbability },
        entropyBits: calculateBinaryEntropy(belief.scamProbability),
        updateStatus,
        probabilityMeaning: lastUpdatedAtEvent
          ? 'posterior_over_modelled_evidence'
          : 'configured_prior',
        lastUpdatedAtEvent,
        unmodelledEvidenceEventIds,
        provenance: config.provenance,
        decision: {
          ...calculation,
          action,
          safetyOverride: action !== calculation.costAction,
          selectedExpectedCost: calculation.expectedCosts[action],
          costs: ordinaryHiringCosts,
          costBasis: 'student_assumed_relative_units_HOLD_up_to_24_hours',
          constraint: step.candidate_recorded
            ? 'candidate_context_only'
            : step.inspection_triggered
              ? 'inspection_in_progress'
              : step.scope === 'wallet_approval'
                ? 'wallet_permission_boundary'
                : 'repository_safety_rules',
        },
      },
    };
  };
}
