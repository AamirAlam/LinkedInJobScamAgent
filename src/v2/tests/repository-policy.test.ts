import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { recommendRepositoryAction } from '../repository-policy.ts';
import type { RepositoryAssessment } from '../repository-policy.ts';

const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../data/synthetic-repository-pair.json'), 'utf8'));

// History-dependent boundary variants are checked by repository-replay.test.ts.
for (const scenario of fixture.cases.filter((item: { evaluation_id: number }) => [101, 107].includes(item.evaluation_id))) {
    test(`synthetic case ${scenario.evaluation_id}: policy follows available evidence`, () => {
        let state: RepositoryAssessment = {
            executionRequested: false, inspection: 'pending', assessmentAuthorisation: 'unresolved',
        };
        let evaluated = 0;
        for (const event of scenario.events) {
            // The policy sees only the current reviewed annotation or check result.
            // Expected actions and scenario ground truth are used only below for scoring.
            const input = event.agent_input;
            if (event.kind === 'message' && input.sender === 'counterparty' &&
                event.reviewed_annotations?.code_execution_request === 'present') {
                state = { ...state, executionRequested: true };
            } else if (event.kind === 'check_result' && input.check === 'repository_inspection') {
                state = { ...state, inspection: input.outcome };
            } else if (event.kind === 'check_result' && input.check === 'assessment_authorisation') {
                state = { ...state, assessmentAuthorisation: input.outcome };
            }
            const recommendation = recommendRepositoryAction(state);
            const expected = scenario.evaluator_only.checkpoints.find(
                (checkpoint: { after_event: string }) => checkpoint.after_event === event.event_id,
            );
            if (expected) {
                assert.equal(recommendation.action, expected.expected_action, `Checkpoint ${event.event_id}`);
                evaluated++;
            }
        }
        assert.equal(evaluated, scenario.evaluator_only.checkpoints.length);
    });
}

test('verified authorisation does not bypass pending or inaccessible repository inspection', () => {
    for (const inspection of ['pending', 'unresolved'] as const) {
        const result = recommendRepositoryAction({ executionRequested: true, inspection, assessmentAuthorisation: 'verified' });
        assert.equal(result.action, 'HOLD');
    }
});

test('harmful findings override authorisation; SAFE retains precautions; invalid findings are rejected', () => {
    assert.equal(recommendRepositoryAction({ executionRequested: true, inspection: 'harmful_behaviour_found', assessmentAuthorisation: 'verified' }).action, 'FLAG');
    const cleared = recommendRepositoryAction({ executionRequested: true, inspection: 'no_harmful_behaviour_found', assessmentAuthorisation: 'verified' });
    assert.equal(cleared.action, 'SAFE');
    assert.ok(cleared.precautions?.length);
    assert.equal(recommendRepositoryAction({ executionRequested: false, inspection: 'pending', assessmentAuthorisation: 'unresolved' }).action, null);
    assert.throws(() => recommendRepositoryAction({ executionRequested: true, inspection: 'unknown' as RepositoryAssessment['inspection'], assessmentAuthorisation: 'verified' }));
});
