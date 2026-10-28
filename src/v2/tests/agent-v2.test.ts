import { loadFixture } from './fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareRepositoryCases } from '../agent-v2.ts';

test('benchmark coverage accounts for all cases and excludes unsupported wallet checks', () => {
  const fixture = loadFixture('synthetic-benchmark-100.json');
  const result = prepareRepositoryCases(fixture, true);
  assert.equal(result.selected.length, 28);
  assert.equal(result.skipped.length, 72);
  assert.equal(
    new Set([...result.selected, ...result.skipped].map((item) => item.evaluation_id)).size,
    100,
  );
  assert.ok(result.skipped.some((item) => item.evaluation_id === 257));
  assert.ok(result.selected.some((item) => item.evaluation_id === 255));
  assert.ok(result.selected.some((item) => item.evaluation_id === 256));
  assert.equal(
    result.plannedMessageCalls,
    result.selected.reduce(
      (count, item) =>
        count +
        item.events.filter(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            'kind' in event &&
            event.kind === 'message' &&
            'agent_input' in event &&
            typeof event.agent_input === 'object' &&
            event.agent_input !== null &&
            'sender' in event.agent_input &&
            event.agent_input.sender === 'counterparty',
        ).length,
      0,
    ),
  );
});

test('default fixture retains all four cases with inherited artifact scope', () => {
  const fixture = loadFixture('synthetic-repository-pair.json');
  const result = prepareRepositoryCases(fixture, false);
  assert.equal(result.selected.length, 4);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.plannedMessageCalls, 9);
  assert.ok(
    result.selected.every((item) => item.assessment_artifact === fixture.assessment_artifact),
  );
});

test('preflight rejects malformed selected cases instead of spending API calls on them', () => {
  const fixture = loadFixture('synthetic-repository-pair.json');
  const malformed = {
    ...fixture,
    cases: fixture.cases.map((scenario, index) =>
      index !== 0
        ? scenario
        : {
            ...scenario,
            events: scenario.events.map((event, eventIndex) =>
              eventIndex !== 3 ? event : { ...event, requested_after_event: 'future-event' },
            ),
          },
    ),
  };
  assert.throws(() => prepareRepositoryCases(malformed, false), /ordering/);
  const badTarget = {
    ...fixture,
    cases: fixture.cases.map((scenario, index) =>
      index !== 0
        ? scenario
        : {
            ...scenario,
            evaluator_only: {
              ...scenario.evaluator_only,
              checkpoints: scenario.evaluator_only.checkpoints.map((checkpoint, checkpointIndex) =>
                checkpointIndex !== 0 ? checkpoint : { ...checkpoint, after_event: 'missing' },
              ),
            },
          },
    ),
  };
  assert.throws(() => prepareRepositoryCases(badTarget, false), /checkpoint/);
  const benchmark = loadFixture('synthetic-benchmark-100.json');
  const badScope = {
    ...benchmark,
    cases: benchmark.cases.map((scenario) =>
      scenario.evaluation_id !== 257
        ? scenario
        : {
            ...scenario,
            evaluator_only: { ...scenario.evaluator_only, runner_scope: 'repository_replay' },
          },
    ),
  };
  assert.throws(() => prepareRepositoryCases(badScope, true));
});
