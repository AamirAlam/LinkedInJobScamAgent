import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEvaluationPartition, validateEvaluationPartition } from '../evaluation-partition.ts';

// Deliberately small synthetic grouping fixtures, not recruitment evidence.
function scenario(id: number, family: string, group: string, text: string, pair?: string) {
  return {
    evaluation_id: id,
    evaluator_only: {
      ground_truth: id % 2 ? 'scam' : 'legitimate',
      family_id: family,
      partition_group: group,
      pair_id: pair,
      runner_scope: 'repository_replay',
      review_status: 'proposed_requires_human_review',
    },
    events: [
      {
        kind: 'message',
        event_id: `event-${id}`,
        agent_input: { sender: 'counterparty', message: text },
      },
    ],
  };
}

const cases = [
  scenario(1, 'family-a', 'group-a', 'One'),
  scenario(2, 'family-a', 'group-b', 'Two'),
  scenario(3, 'family-c', 'group-b', 'Three', 'shared-pair'),
  scenario(4, 'family-d', 'group-d', 'Four', 'shared-pair'),
  scenario(5, 'family-e', 'group-e', 'Four'),
  scenario(6, 'separate', 'separate', 'Independent fixture'),
  scenario(7, 'another', 'another', 'Another fixture'),
];
const source = { origin: 'synthetic', held_out: false, cases };

test('partition keeps transitive families, pairs and identical visible conversations together', () => {
  const partition = createEvaluationPartition(JSON.stringify(source), 'fixture.json');
  const connected = partition.groups.find((group) => group.case_ids.includes(1));
  assert.deepEqual(connected?.case_ids, [1, 2, 3, 4, 5]);
  const estimation = partition.partitions.estimation.case_ids;
  const evaluation = partition.partitions.evaluation.case_ids;
  assert.equal(new Set([...estimation, ...evaluation]).size, cases.length);
  assert.equal(
    estimation.some((id) => evaluation.includes(id)),
    false,
  );
  assert.equal(partition.readiness.genuinely_held_out, false);
  assert.equal(partition.readiness.broad_generalisation_claim_ready, false);
});

test('partition membership is deterministic, input-order independent and not stratified using labels', () => {
  const first = createEvaluationPartition(JSON.stringify(source), 'fixture.json');
  const reordered = createEvaluationPartition(
    JSON.stringify({ ...source, cases: [...cases].toReversed() }),
    'fixture.json',
  );
  const relabelled = createEvaluationPartition(
    JSON.stringify({
      ...source,
      cases: cases.map((item) => ({
        ...item,
        evaluator_only: { ...item.evaluator_only, ground_truth: 'unknown' },
      })),
    }),
    'fixture.json',
  );
  assert.deepEqual(first.groups, reordered.groups);
  assert.deepEqual(first.groups, relabelled.groups);
  assert.notEqual(first.source_sha256, reordered.source_sha256);
  assert.notEqual(first.source_sha256, relabelled.source_sha256);
});

test('validation rejects changed source bytes, edited partitions, duplicate IDs and inseparable data', () => {
  const raw = JSON.stringify(source);
  const partition = createEvaluationPartition(raw, 'fixture.json');
  assert.deepEqual(validateEvaluationPartition(partition, raw, 'fixture.json'), partition);
  assert.throws(() => validateEvaluationPartition(partition, `${raw}\n`, 'fixture.json'));
  assert.throws(() =>
    validateEvaluationPartition(
      { ...partition, evaluation_validity: 'held_out' },
      raw,
      'fixture.json',
    ),
  );
  assert.throws(() => validateEvaluationPartition(partition, raw, 'other.json'));
  assert.throws(
    () =>
      createEvaluationPartition(
        JSON.stringify({ ...source, cases: [cases[0], cases[0]] }),
        'fixture.json',
      ),
    /unique/,
  );
  assert.throws(
    () =>
      createEvaluationPartition(
        JSON.stringify({ ...source, cases: cases.slice(0, 5) }),
        'fixture.json',
      ),
    /impossible/,
  );
});

test('coverage preserves unsupported cases and unknown labels rather than treating them as correct predictions', () => {
  const raw = JSON.stringify({
    ...source,
    cases: cases.map((item) =>
      item.evaluation_id !== 7
        ? item
        : {
            ...item,
            evaluator_only: {
              ...item.evaluator_only,
              runner_scope: 'requires_broader_threat_runner',
              ground_truth: 'unknown',
            },
          },
    ),
  });
  const partition = createEvaluationPartition(raw, 'fixture.json');
  const partitionWithGap = Object.values(partition.partitions).find((part) =>
    part.case_ids.includes(7),
  )!;
  assert.deepEqual(partitionWithGap.repository_runner.unsupported_case_ids, [7]);
  assert.equal(partitionWithGap.label_counts.unknown, 1);
  assert.equal(partitionWithGap.repository_runner.supported_case_ids.includes(7), false);
});
