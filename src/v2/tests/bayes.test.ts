import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { applyCheckResult, applyEvidence, calculateScamProbability } from '../bayes.ts';

// Arithmetic examples only; these are not recruitment likelihood estimates.
const exercise = { likelihoodGivenScam: 0.3, likelihoodGivenLegitimate: 0.1 };
const initial = () => ({ scamProbability: 0.2, appliedEvidenceIds: [] });

test('sequential Bayes update uses the posterior as the next prior without mutating history', () => {
    const start = initial();
    const first = applyEvidence(start, 'exercise:first', exercise);
    assert.equal(first.status, 'updated');
    assert.ok(Math.abs(first.state.scamProbability - 3 / 7) < 1e-12);
    const second = applyEvidence(first.state, 'exercise:second', exercise);
    assert.ok(Math.abs(second.state.scamProbability - 9 / 13) < 1e-12);
    assert.deepEqual(start, initial());
    assert.strictEqual(applyEvidence(first.state, 'exercise:first', exercise).state, first.state);
});

test('probability boundaries, invalid numbers, and impossible evidence preserve their meanings', () => {
    assert.equal(calculateScamProbability(0, 1, 1), 0);
    assert.equal(calculateScamProbability(1, 1, 1), 1);
    assert.equal(calculateScamProbability(0.2, 0, 0), 'unsupported_evidence');
    assert.equal(calculateScamProbability(0, 1, 0), 'unsupported_evidence');
    for (const bad of [NaN, Infinity, -0.1, 1.1]) {
        assert.throws(() => calculateScamProbability(bad, 0.3, 0.1), RangeError);
        assert.throws(() => calculateScamProbability(0.2, bad, 0.1), RangeError);
        assert.throws(() => calculateScamProbability(0.2, 0.3, bad), RangeError);
    }
    const start = initial();
    const unsupported = applyEvidence(start, 'impossible', {
        likelihoodGivenScam: 0, likelihoodGivenLegitimate: 0,
    });
    assert.equal(unsupported.status, 'unsupported_evidence');
    assert.strictEqual(unsupported.state, start);
});

test('matched cases share visible history and unmodelled check results cannot silently update belief', () => {
    const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../data/synthetic-repository-pair.json'), 'utf8'));
    const [legitimate, scam] = fixture.cases;
    assert.deepEqual(legitimate.events.slice(0, 3), scam.events.slice(0, 3));
    for (const scenario of fixture.cases) {
        const start = initial();
        for (const event of scenario.events) {
            const result = applyCheckResult(start, event, {});
            assert.equal(result.status, event.kind === 'check_result' ? 'unmodelled_evidence' : 'no_check_result');
            assert.strictEqual(result.state, start);
        }
    }
});

test('completed check uses a supplied row and repeated observations count only once', () => {
    const event = { kind: 'check_result', agent_input: {
        check: 'arithmetic_exercise', outcome: 'positive', artifact: 'exercise-item',
    } };
    const table = { 'arithmetic_exercise:positive': exercise };
    const first = applyCheckResult(initial(), event, table);
    assert.equal(first.status, 'updated');
    assert.ok(Math.abs(first.state.scamProbability - 3 / 7) < 1e-12);
    const repeated = applyCheckResult(first.state, event, table);
    assert.equal(repeated.status, 'duplicate_evidence');
    assert.strictEqual(repeated.state, first.state);
    assert.throws(() => applyCheckResult(initial(), { kind: 'check_result', agent_input: {} }, table));
});
