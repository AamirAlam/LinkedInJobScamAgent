import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { replayRepositoryEvents } from '../repository-replay.ts';
import type { RepositoryReplayStep } from '../repository-replay.ts';
import type { ExecutionAnnotation, VisibleMessage } from '../execution-extractor.ts';

const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../data/synthetic-repository-pair.json'), 'utf8'));
const calls: VisibleMessage[][] = [];
const stub = async (messages: readonly VisibleMessage[]): Promise<ExecutionAnnotation> => {
    calls.push(structuredClone([...messages]));
    const request = messages.find(message => message.sender === 'counterparty' && message.message.includes('run it locally'));
    return request
        ? { status: 'present', first_explicit_request_message: request.time, supporting_message: request.time, quote: 'run it locally', reason: 'Test annotation for the visible request.' }
        : { status: 'absent_so_far', first_explicit_request_message: null, supporting_message: null, quote: null, reason: 'No request visible in this test prefix.' };
};
async function collect(events: readonly unknown[]) {
    const steps: RepositoryReplayStep[] = [];
    for await (const step of replayRepositoryEvents(events, fixture.assessment_artifact, stub)) steps.push(step);
    return steps;
}

test('replay uses only arrived messages, ignores supplied annotations, and then applies check results', async () => {
    for (const scenario of fixture.cases) {
        calls.length = 0;
        const events = structuredClone(scenario.events);
        for (const event of events) if (event.kind === 'message') {
            event.reviewed_annotations = { code_execution_request: 'absent_so_far' }; // must not drive policy
            event.agent_input.ground_truth = 'scam'; // must not enter extraction
        }
        const steps = await collect(events);
        const messageCount = events.filter((event: { kind: string }) => event.kind === 'message').length;
        assert.deepEqual(calls.map(messages => messages.length), Array.from({ length: messageCount }, (_, index) => index + 1));
        assert.ok(calls.every(messages => messages.every(message =>
            Object.keys(message).sort().join(',') === 'message,sender,time')));
        assert.equal(steps[0].assessment.executionRequested, false);
        assert.equal(steps[2].recommendation.action, 'HOLD');
        for (const expected of scenario.evaluator_only.checkpoints) {
            assert.equal(steps.find(step => step.event_id === expected.after_event)?.recommendation.action, expected.expected_action);
        }
    }
});

test('wrong-artifact, premature, and repeated check events are rejected', async () => {
    const events = fixture.cases[0].events;
    const wrong = structuredClone(events);
    wrong[3].agent_input.artifact = 'https://other.example.invalid/repository';
    await assert.rejects(collect(wrong), /repository visible/);
    const lookalike = structuredClone(events);
    lookalike[2].agent_input.message = lookalike[2].agent_input.message.replace(fixture.assessment_artifact, fixture.assessment_artifact + '-other');
    await assert.rejects(collect(lookalike), /repository visible/);
    await assert.rejects(collect([events[3], ...events.slice(0, 3)]), /earlier event/);
    await assert.rejects(collect([...events, events[3]]), /Duplicate event/);
});

test('a later clean result cannot erase an observed harmful finding', async () => {
    const scam = fixture.cases[1];
    const clean = structuredClone(fixture.cases[0].events[3]);
    clean.event_id = 'e5';
    clean.requested_after_event = 'e4';
    const steps = await collect([...scam.events, clean]);
    assert.equal(steps[3].recommendation.action, 'FLAG');
    assert.equal(steps[4].recommendation.action, 'FLAG');
    assert.equal(steps[2].assessment.inspection, 'pending');
});
