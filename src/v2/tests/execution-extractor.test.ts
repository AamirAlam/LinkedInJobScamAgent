import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateExecutionAnnotation, visibleMessages, visibleMessagePrefixes, executionOutputSchema } from '../execution-extractor.ts';
import type { VisibleMessage } from '../execution-extractor.ts';

const messages: VisibleMessage[] = [
    { time: 't0', sender: 'candidate', message: 'Should I run the project?' },
    { time: 't1', sender: 'counterparty', message: 'Please run the project locally.' },
];
const present = { status: 'present', first_explicit_request_message: 't1', supporting_message: 't1', quote: 'run the project locally', reason: 'Explicit execution request.' };

test('model input projects visible messages and rejects duplicate references', () => {
    const labelled = messages.map(message => ({ ...message, ground_truth: 'scam', sender_name: 'Fake recruiter', expected_action: 'FLAG' }));
    assert.deepEqual(visibleMessages(labelled), messages);
    assert.throws(() => visibleMessages([messages[0], messages[0]]));
    assert.throws(() => visibleMessages([]));
});

test('prefixes reveal only arrived messages and validate evidence against that prefix', () => {
    const prefixes = visibleMessagePrefixes(messages);
    assert.deepEqual(prefixes, [[messages[0]], messages]);
    assert.equal(prefixes[0].some(message => message.time === 't1'), false);
    assert.throws(() => validateExecutionAnnotation(present, prefixes[0]));
    assert.deepEqual(validateExecutionAnnotation(present, prefixes[1]), present);
    prefixes[0].push({ time: 'extra', sender: 'candidate', message: 'Local mutation' });
    assert.equal(prefixes[1].length, 2);
    assert.equal(messages.length, 2);
});

test('supporting quotes must be real counterparty evidence in the visible prefix', () => {
    assert.deepEqual(validateExecutionAnnotation(present, messages), present);
    assert.throws(() => validateExecutionAnnotation(present, messages.slice(0, 1)));
    assert.throws(() => validateExecutionAnnotation({ ...present, quote: 'install malware' }, messages));
    assert.throws(() => validateExecutionAnnotation({ ...present, first_explicit_request_message: 't0', supporting_message: 't0', quote: 'run the project' }, messages));
});

test('non-present annotations cannot claim an explicit request or return probabilities or actions', () => {
    const absent = { status: 'absent_so_far', first_explicit_request_message: null, supporting_message: null, quote: null, reason: 'No request visible.' };
    assert.deepEqual(validateExecutionAnnotation(absent, messages.slice(0, 1)), absent);
    assert.throws(() => validateExecutionAnnotation({ ...present, status: 'absent_so_far' }, messages));
    assert.throws(() => validateExecutionAnnotation({ ...absent, scamProbability: 0.9 }, messages));
    assert.throws(() => validateExecutionAnnotation({ ...absent, action: 'FLAG' }, messages));
    assert.throws(() => validateExecutionAnnotation({ ...absent, status: 'ambiguous' }, messages));
});

test('the API output schema prevents inconsistent request references before application validation', () => {
    assert.deepEqual(executionOutputSchema.parse({ annotation: present }), { annotation: present });
    assert.throws(() => executionOutputSchema.parse({ annotation: { ...present, status: 'ambiguous' } }));
    assert.throws(() => executionOutputSchema.parse({ annotation: { ...present, status: 'absent_so_far' } }));
});
