import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  projectBaselineEvidence,
  replayDirectEvidence,
  validateDirectDecision,
} from '../direct-evidence-baseline.ts';
import { prepareDirectBaseline, runDirectBaseline } from '../scripts/evaluate_direct_baseline.ts';
import { collectSteps, loadFixture } from './fixtures.ts';

const scenario = loadFixture('repository-evaluation-v1.json').cases[0];
const intro = scenario.events[0];
assert.equal(intro.kind, 'message');
const decision = {
  action: 'SAFE',
  scope: 'conversation_only',
  reason: 'No execution request established yet.',
  citations: [{ event_id: intro.event_id, field: 'message', quote: intro.agent_input.message }],
};
const referencePath = 'results/repository-challenge-2026-10-28T11-26-41-962Z.json';
const rawReference = readFileSync(referencePath, 'utf8');

test('baseline projection hides labels, reviewer annotations and future evidence', () => {
  const projected = projectBaselineEvidence([
    {
      ...intro,
      evaluator_only: { ground_truth: 'scam' },
      reviewed_annotations: { expected_action: 'FLAG' },
      agent_input: { ...intro.agent_input, ground_truth: 'scam' },
    },
  ]);
  assert.equal(projected.length, 1);
  assert.deepEqual(Object.keys(projected[0]).toSorted(), ['agent_input', 'event_id', 'kind']);
  assert.deepEqual(Object.keys(projected[0].agent_input).toSorted(), ['message', 'sender']);
  assert.equal(JSON.stringify(projected).includes('ground_truth'), false);
  assert.equal(JSON.stringify(projected).includes('e4'), false);
});

test('baseline validates exact arrived citations and rejects invented, future and candidate-only evidence', () => {
  assert.equal(validateDirectDecision(decision, [intro]).action, 'SAFE');
  assert.throws(() =>
    validateDirectDecision(
      { ...decision, citations: [{ event_id: 'e5', field: 'outcome', quote: 'verified' }] },
      [intro],
    ),
  );
  assert.throws(() =>
    validateDirectDecision(
      {
        ...decision,
        citations: [{ event_id: 'e1', field: 'message', quote: 'not in the source' }],
      },
      [intro],
    ),
  );
  const candidate = scenario.events[1];
  assert.equal(candidate.kind, 'message');
  assert.throws(() =>
    validateDirectDecision(
      {
        ...decision,
        citations: [
          { event_id: candidate.event_id, field: 'message', quote: candidate.agent_input.message },
        ],
      },
      [intro, candidate],
    ),
  );
  assert.throws(() => validateDirectDecision({ ...decision, citations: [] }, [intro]));
  assert.throws(() => validateDirectDecision({ ...decision, probability: 0.5 }, [intro]));
  const inspectionDecision = {
    ...decision,
    action: 'HOLD',
    scope: 'repository_execution',
    citations: [{ event_id: 'e4', field: 'outcome', quote: 'no_harmful_behaviour_found' }],
  };
  assert.equal(
    validateDirectDecision(inspectionDecision, scenario.events.slice(0, 4)).action,
    'HOLD',
  );
  assert.throws(() => validateDirectDecision(inspectionDecision, scenario.events.slice(0, 3)));
  assert.throws(() =>
    validateDirectDecision(
      {
        ...inspectionDecision,
        citations: [
          { event_id: 'e4', field: 'outcome', quote: 'outcome: "no_harmful_behaviour_found"' },
        ],
      },
      scenario.events.slice(0, 4),
    ),
  );
  assert.throws(() =>
    validateDirectDecision(
      {
        ...decision,
        citations: [
          { event_id: intro.event_id, field: 'outcome', quote: intro.agent_input.message },
        ],
      },
      [intro],
    ),
  );
});

test('baseline makes no candidate calls and includes arrived checks for later decisions', async () => {
  let prefixLengths: number[] = [];
  const steps = await collectSteps(
    replayDirectEvidence(scenario.events, async (events) => {
      prefixLengths = [...prefixLengths, events.length];
      assert.ok(events.length <= 5);
      return validateDirectDecision(decision, events);
    }),
  );
  assert.deepEqual(prefixLengths, [1, 3, 4, 5]);
  assert.equal(steps[1].candidate_context_only, true);
  assert.deepEqual(steps[1].decision, steps[0].decision);
  let calls = 0;
  const candidateOnly = await collectSteps(
    replayDirectEvidence([scenario.events[1]], async () => {
      calls += 1;
      return validateDirectDecision(decision, [intro]);
    }),
  );
  assert.equal(calls, 0);
  assert.equal(candidateOnly[0].decision, null);
});

test('baseline preflight rejects mismatched or incomplete references before model calls', async () => {
  const prepared = prepareDirectBaseline(rawReference);
  assert.equal(prepared.prepared.coverage.selected.length, 24);
  const reference: { model: string; results: unknown[] } = JSON.parse(rawReference);
  assert.throws(
    () => prepareDirectBaseline(JSON.stringify({ ...reference, model: 'different-model' })),
    /share/,
  );
  assert.throws(
    () =>
      prepareDirectBaseline(JSON.stringify({ ...reference, results: reference.results.slice(1) })),
    /Incomplete/,
  );
  await runDirectBaseline([referencePath, '--dry-run']);
  await assert.rejects(runDirectBaseline(['--dry-run']), /Use --challenge-baseline/);
});
