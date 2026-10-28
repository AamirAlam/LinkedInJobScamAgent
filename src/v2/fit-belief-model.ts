import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateEvaluationPartition } from './evaluation-partition.ts';
import { parseConversationBeliefConfig } from './conversation-belief.ts';

const outcomes = ['unresolved', 'no_harmful_behaviour_found', 'harmful_behaviour_found'] as const;
const caseSchema = z.object({
  evaluation_id: z.number().int(),
  evaluator_only: z.object({
    ground_truth: z.enum(['scam', 'legitimate', 'unknown']),
    execution_request_status: z.enum(['present', 'absent_so_far', 'ambiguous']),
  }),
  events: z.array(
    z.object({
      kind: z.string(),
      agent_input: z.object({ check: z.string().optional(), outcome: z.string().optional() }),
    }),
  ),
});
type Scenario = z.infer<typeof caseSchema>;

function countGroup(cases: readonly Scenario[]) {
  const execution = cases.filter(
    (scenario) => scenario.evaluator_only.execution_request_status === 'present',
  );
  const results = execution.flatMap((scenario) => {
    const first = scenario.events.find(
      (event) =>
        event.kind === 'check_result' && event.agent_input.check === 'repository_inspection',
    );
    return first ? [z.enum(outcomes).parse(first.agent_input.outcome)] : [];
  });
  return {
    cases: cases.length,
    execution_requests: execution.length,
    first_inspections: results.length,
    execution_without_inspection: execution.length - results.length,
    inspection_outcomes: {
      unresolved: results.filter((outcome) => outcome === 'unresolved').length,
      no_harmful_behaviour_found: results.filter(
        (outcome) => outcome === 'no_harmful_behaviour_found',
      ).length,
      harmful_behaviour_found: results.filter((outcome) => outcome === 'harmful_behaviour_found')
        .length,
    },
  };
}

/** Fit unsmoothed synthetic proportions using estimation IDs only; never infer labels or pseudocounts. */
export function fitEstimationBelief(rawSource: string, sourceFile: string, rawPartition: string) {
  const partition = validateEvaluationPartition(JSON.parse(rawPartition), rawSource, sourceFile);
  const source = z.object({ cases: z.array(caseSchema) }).parse(JSON.parse(rawSource));
  const estimationIds = partition.partitions.estimation.case_ids;
  const estimation = source.cases.filter((scenario) =>
    estimationIds.includes(scenario.evaluation_id),
  );
  const known = estimation.filter((scenario) => scenario.evaluator_only.ground_truth !== 'unknown');
  if (known.some((scenario) => scenario.evaluator_only.execution_request_status === 'ambiguous')) {
    throw new Error(
      'Ambiguous execution annotations need review before binary likelihood estimation.',
    );
  }
  const scam = countGroup(
    known.filter((scenario) => scenario.evaluator_only.ground_truth === 'scam'),
  );
  const legitimate = countGroup(
    known.filter((scenario) => scenario.evaluator_only.ground_truth === 'legitimate'),
  );
  if (!scam.cases || !legitimate.cases) {
    throw new Error(
      'Both known-label groups need estimation cases; no missing rates are invented.',
    );
  }
  const firstInspectionLikelihoods =
    scam.first_inspections && legitimate.first_inspections
      ? Object.fromEntries(
          outcomes.map((outcome) => [
            `repository_inspection:${outcome}`,
            {
              likelihoodGivenScam: scam.inspection_outcomes[outcome] / scam.first_inspections,
              likelihoodGivenLegitimate:
                legitimate.inspection_outcomes[outcome] / legitimate.first_inspections,
            },
          ]),
        )
      : {};
  const model = parseConversationBeliefConfig({
    schema_version: 1,
    purpose: 'repository_conversation_belief',
    priorScam: scam.cases / known.length,
    executionLikelihoods: {
      likelihoodGivenScam: scam.execution_requests / scam.cases,
      likelihoodGivenLegitimate: legitimate.execution_requests / legitimate.cases,
    },
    firstInspectionLikelihoods,
    provenance: {
      kind: 'synthetic',
      source: `${sourceFile}; source SHA-256 ${partition.source_sha256}; fixed ${partition.seed} estimation IDs only. Unsmoothed authored counts, not independent observations.`,
      limitations:
        'Retrospective development estimates from stipulated synthetic labels and proposed annotations. Unknown states excluded. No pseudocounts: unobserved outcomes may have zero likelihood in both groups, causing unsupported evidence. First-inspection rates condition on explicit execution and an available scripted inspection. Not deployment prevalence or calibrated probabilities. Costs remain student-assumed; no numerical wallet or authorisation model.',
    },
  });
  return {
    model,
    audit: {
      purpose: 'synthetic_estimation_only_fit',
      source_file: sourceFile,
      source_sha256: partition.source_sha256,
      partition_sha256: createHash('sha256').update(rawPartition).digest('hex'),
      estimation_case_ids: estimationIds,
      evaluation_case_ids_excluded: partition.partitions.evaluation.case_ids,
      unknown_estimation_case_ids_excluded: estimation
        .filter((scenario) => scenario.evaluator_only.ground_truth === 'unknown')
        .map((scenario) => scenario.evaluation_id)
        .toSorted((left, right) => left - right),
      counts: { scam, legitimate },
      smoothing: 'none_no_pseudocounts',
      zero_in_both_groups: outcomes.filter(
        (outcome) =>
          scam.first_inspections > 0 &&
          legitimate.first_inspections > 0 &&
          scam.inspection_outcomes[outcome] === 0 &&
          legitimate.inspection_outcomes[outcome] === 0,
      ),
      targets_independently_reviewed: false,
      deployment_validated: false,
    },
  };
}
