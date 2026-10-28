import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

export const PARTITION_SEED = 'week2-v2-partition-v1';
const ESTIMATION_GROUP_FRACTION = 0.7;
const metadataSchema = z.object({
  ground_truth: z.enum(['scam', 'legitimate', 'unknown']),
  family_id: z.string().trim().min(1),
  partition_group: z.string().trim().min(1),
  pair_id: z.string().trim().min(1).optional(),
  source_pair_id: z.string().trim().min(1).optional(),
  runner_scope: z.enum(['repository_replay', 'requires_broader_threat_runner']),
  review_status: z.string().trim().min(1),
});
const sourceSchema = z.object({
  origin: z.literal('synthetic'),
  held_out: z.boolean(),
  cases: z
    .array(
      z.object({
        evaluation_id: z.number().int().positive(),
        evaluator_only: metadataSchema,
        events: z
          .array(
            z.discriminatedUnion('kind', [
              z.object({
                kind: z.literal('message'),
                agent_input: z.object({
                  sender: z.enum(['candidate', 'counterparty']),
                  message: z.string().min(1),
                }),
              }),
              z.object({ kind: z.literal('check_result'), agent_input: z.unknown() }),
            ]),
          )
          .min(1),
      }),
    )
    .min(2),
});
type Scenario = z.infer<typeof sourceSchema>['cases'][number];

function hash(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function readGroupingKeys(scenario: Scenario): readonly string[] {
  const metadata = scenario.evaluator_only;
  const visibleMessages = scenario.events.flatMap((event) =>
    event.kind === 'message' ? [event.agent_input] : [],
  );
  if (!visibleMessages.length) {
    throw new Error(`Case ${scenario.evaluation_id} has no visible conversation.`);
  }
  return [
    `family:${metadata.family_id}`,
    `group:${metadata.partition_group}`,
    `visible:${hash(JSON.stringify(visibleMessages))}`,
    ...[metadata.pair_id, metadata.source_pair_id].flatMap((pair) =>
      pair ? [`pair:${pair}`] : [],
    ),
  ];
}

function groupRelatedCases(cases: readonly Scenario[]) {
  let components: readonly { cases: readonly Scenario[]; keys: ReadonlySet<string> }[] = [];
  for (const scenario of cases) {
    const keys = readGroupingKeys(scenario);
    const related = components.filter((component) => keys.some((key) => component.keys.has(key)));
    components = [
      ...components.filter((component) => !related.includes(component)),
      {
        cases: [scenario, ...related.flatMap((component) => component.cases)],
        keys: new Set([...keys, ...related.flatMap((component) => [...component.keys])]),
      },
    ];
  }
  return components;
}

function countLabels(cases: readonly Scenario[]) {
  return {
    scam: cases.filter((scenario) => scenario.evaluator_only.ground_truth === 'scam').length,
    legitimate: cases.filter((scenario) => scenario.evaluator_only.ground_truth === 'legitimate')
      .length,
    unknown: cases.filter((scenario) => scenario.evaluator_only.ground_truth === 'unknown').length,
  };
}

function summarisePartition(cases: readonly Scenario[], groupIds: readonly string[]) {
  const sorted = [...cases].toSorted((left, right) => left.evaluation_id - right.evaluation_id);
  const supported = sorted.filter(
    (scenario) => scenario.evaluator_only.runner_scope === 'repository_replay',
  );
  return {
    case_ids: sorted.map((scenario) => scenario.evaluation_id),
    group_ids: [...groupIds].toSorted(),
    label_counts: countLabels(sorted),
    repository_runner: {
      supported_case_ids: supported.map((scenario) => scenario.evaluation_id),
      supported_label_counts: countLabels(supported),
      supported_families: [
        ...new Set(supported.map((scenario) => scenario.evaluator_only.family_id)),
      ].toSorted(),
      unsupported_case_ids: sorted
        .filter((scenario) => scenario.evaluator_only.runner_scope !== 'repository_replay')
        .map((scenario) => scenario.evaluation_id),
    },
    proposed_target_case_ids: sorted
      .filter(
        (scenario) => scenario.evaluator_only.review_status === 'proposed_requires_human_review',
      )
      .map((scenario) => scenario.evaluation_id),
  };
}

/** Partition previously exposed synthetic development cases; this cannot create a held-out test set. */
export function createEvaluationPartition(rawSource: string, sourceFile: string) {
  const source = sourceSchema.parse(JSON.parse(rawSource));
  if (!sourceFile.trim()) {
    throw new Error('Source file is required.');
  }
  const ids = source.cases.map((scenario) => scenario.evaluation_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('Case IDs must be unique.');
  }
  const components = groupRelatedCases(source.cases)
    .map((component) => {
      const caseIds = component.cases
        .map((scenario) => scenario.evaluation_id)
        .toSorted((left, right) => left - right);
      return {
        ...component,
        id: `cases:${caseIds.join(',')}`,
        rank: hash(`${PARTITION_SEED}:${caseIds.join(',')}`),
        caseIds,
      };
    })
    .toSorted((left, right) => left.rank.localeCompare(right.rank));
  if (components.length < 2) {
    throw new Error(
      'All cases belong to one connected family; a disjoint partition is impossible.',
    );
  }
  const splitAt = Math.max(
    1,
    Math.min(components.length - 1, Math.floor(components.length * ESTIMATION_GROUP_FRACTION)),
  );
  const estimation = components.slice(0, splitAt);
  const evaluation = components.slice(splitAt);
  const evaluationSummary = summarisePartition(
    evaluation.flatMap((component) => component.cases),
    evaluation.map((component) => component.id),
  );
  return {
    schema_version: 1,
    purpose: 'synthetic_development_group_partition',
    source_file: sourceFile,
    source_sha256: hash(rawSource),
    source_declared_held_out: source.held_out,
    evaluation_validity: 'retrospective_previously_exposed_not_held_out',
    seed: PARTITION_SEED,
    estimation_group_fraction: ESTIMATION_GROUP_FRACTION,
    assignment_rule:
      'connected_families_pairs_and_identical_visible_messages_then_seeded_hash_no_label_stratification',
    partitions: {
      estimation: summarisePartition(
        estimation.flatMap((component) => component.cases),
        estimation.map((component) => component.id),
      ),
      evaluation: evaluationSummary,
    },
    groups: components.map((component, index) => ({
      group_id: component.id,
      partition: index < splitAt ? 'estimation' : 'evaluation',
      case_ids: component.caseIds,
      family_ids: [
        ...new Set(component.cases.map((scenario) => scenario.evaluator_only.family_id)),
      ].toSorted(),
      partition_groups: [
        ...new Set(component.cases.map((scenario) => scenario.evaluator_only.partition_group)),
      ].toSorted(),
    })),
    readiness: {
      genuinely_held_out: false,
      full_evaluation_runner_coverage:
        evaluationSummary.repository_runner.unsupported_case_ids.length === 0,
      repository_evaluation_family_count:
        evaluationSummary.repository_runner.supported_families.length,
      evaluation_targets_awaiting_review: evaluationSummary.proposed_target_case_ids.length,
      broad_generalisation_claim_ready: false,
    },
    limitations: [
      'Previously inspected and used for development. Retrospective partitioning does not undo prior exposure or constitute a held-out evaluation.',
      'Assignment is fixed by the recorded seed and family components, not tuned to label balance or model results.',
      'Grouping protects declared families/pairs and exact visible-message duplicates; it does not prove semantic independence of authored templates.',
      'Fit any new model using estimation IDs only. Existing all-100-case synthetic likelihoods contain evaluation-label information and are ineligible for a partition-isolated comparison.',
      'Unsupported runner cases remain explicit coverage gaps. Unknown states are not binary ground truth. Proposed targets still require review.',
      'Authored label proportions cannot estimate deployment prevalence or calibrated real-world likelihoods.',
    ],
  };
}

/** Verify source bytes and the complete deterministic assignment before consuming a saved partition. */
export function validateEvaluationPartition(input: unknown, rawSource: string, sourceFile: string) {
  const expected = createEvaluationPartition(rawSource, sourceFile);
  if (!isDeepStrictEqual(input, expected)) {
    throw new Error(
      'Partition does not match its source snapshot, grouping rules or fixed assignment.',
    );
  }
  return expected;
}
