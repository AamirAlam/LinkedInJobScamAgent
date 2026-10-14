import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { prepareRepositoryCases } from '../agent-v2.ts';

const load = (name: string) => JSON.parse(readFileSync(resolve(__dirname, '../../../data/synthesis', name), 'utf8'));

test('benchmark coverage accounts for all cases and excludes unsupported wallet checks', () => {
    const fixture = load('synthetic-benchmark-100.json');
    const result = prepareRepositoryCases(fixture, true);
    assert.equal(result.selected.length, 28);
    assert.equal(result.skipped.length, 72);
    assert.equal(new Set([...result.selected, ...result.skipped].map(item => item.evaluation_id)).size, 100);
    assert.ok(result.skipped.some(item => item.evaluation_id === 257));
    assert.ok(result.selected.some(item => item.evaluation_id === 255));
    assert.ok(result.selected.some(item => item.evaluation_id === 256));
    assert.equal(result.plannedMessageCalls, result.selected.reduce((count, item) =>
        count + item.events.filter((event: any) => event.kind === 'message').length, 0));
});

test('default fixture retains all four cases with inherited artifact scope', () => {
    const fixture = load('synthetic-repository-pair.json');
    const result = prepareRepositoryCases(fixture, false);
    assert.equal(result.selected.length, 4);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.plannedMessageCalls, 13);
    assert.ok(result.selected.every(item => item.assessment_artifact === fixture.assessment_artifact));
});

test('preflight rejects malformed selected cases instead of spending API calls on them', () => {
    const fixture = load('synthetic-repository-pair.json');
    const malformed = structuredClone(fixture);
    malformed.cases[0].events[3].requested_after_event = 'future-event';
    assert.throws(() => prepareRepositoryCases(malformed, false), /ordering/);
    const badTarget = structuredClone(fixture);
    badTarget.cases[0].evaluator_only.checkpoints[0].after_event = 'missing';
    assert.throws(() => prepareRepositoryCases(badTarget, false), /checkpoint/);
    const badScope = load('synthetic-benchmark-100.json');
    badScope.cases.find((item: { evaluation_id: number }) => item.evaluation_id === 257).evaluator_only.runner_scope = 'repository_replay';
    assert.throws(() => prepareRepositoryCases(badScope, true));
});
