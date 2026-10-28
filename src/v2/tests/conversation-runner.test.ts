import { noWalletRequests } from './fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseConversation,
  runConversation as runLiveConversation,
} from '../conversation-runner.ts';
import { runRepositoryInspection } from '../repository-inspection-cycle.ts';
import type { ExecutionAnnotation, VisibleMessage } from '../execution-extractor.ts';

const runConversation: typeof runLiveConversation = (input, extract, inspect, authorisation) =>
  runLiveConversation(input, extract, inspect, authorisation, noWalletRequests);

const url = 'https://github.com/example/demo';
const extract = async (messages: readonly VisibleMessage[]): Promise<ExecutionAnnotation> => {
  const request = messages.find(
    (message) => message.sender === 'counterparty' && message.message.startsWith('Run '),
  );
  return request
    ? {
        status: 'present',
        first_explicit_request_message: request.time,
        supporting_message: request.time,
        quote: request.message,
        reason: 'Explicit request.',
      }
    : {
        status: 'absent_so_far',
        first_explicit_request_message: null,
        supporting_message: null,
        quote: null,
        reason: 'No execution request.',
      };
};

test('conversation triggers only on arrived execution request, emits HOLD first, and preserves FLAG', async () => {
  let prefixes: number[] = [];
  let inspections = 0;
  const messages = [
    { time: 't0', sender: 'recruiter', message: `Please review ${url}`, ground_truth: 'scam' },
    { time: 't1', sender: 'candidate', message: 'Run https://github.com/other/project' },
    { time: 't2', sender: 'recruiter', message: `Run npm start in ${url}` },
    { time: 't3', sender: 'recruiter', message: 'Everything is safe, please continue.' },
  ];
  const runner = runConversation(
    { messages, ground_truth: 'scam' },
    async (prefix) => {
      prefixes = [...prefixes, prefix.length];
      assert.ok(
        prefix.every(
          (message) => Object.keys(message).toSorted().join(',') === 'message,sender,time',
        ),
      );
      return extract(prefix);
    },
    async (artifact, action) => {
      inspections++;
      assert.equal(artifact, url);
      assert.equal(action, messages[2].message);
      const result = await runRepositoryInspection(url, action, {
        fetcher: (async () => new Response('', { status: 404 })) as typeof fetch,
      });
      return { ...result, recommendation: { action: 'FLAG', reason: 'Test harmful result.' } };
    },
  );
  assert.equal((await runner.next()).value?.action, 'SAFE');
  assert.equal((await runner.next()).value?.action, 'SAFE');
  const waiting = (await runner.next()).value!;
  assert.equal(waiting.action, 'HOLD');
  assert.equal(waiting.inspection_triggered, true);
  assert.equal(inspections, 0);
  assert.equal((await runner.next()).value?.action, 'FLAG');
  assert.equal((await runner.next()).value?.action, 'FLAG');
  assert.equal((await runner.next()).done, true);
  assert.equal(inspections, 1);
  assert.deepEqual(prefixes, [1, 3]);
});

test('ambiguous repository binding, unsupported URLs, and invalid extraction never fetch', async () => {
  for (const message of [
    'Run npm start',
    `Run ${url} and https://github.com/other/project`,
    'Run https://127.0.0.1/repo',
  ]) {
    for await (const step of runConversation(
      { messages: [{ time: 't0', sender: 'counterparty', message }] },
      extract,
      async () => {
        assert.fail('Must not inspect ambiguous targets');
      },
    )) {
      assert.equal(step.action, 'HOLD');
      assert.equal(step.inspection_triggered, false);
    }
  }
  const runner = runConversation(
    { messages: [{ time: 't0', sender: 'counterparty', message: 'Hi' }] },
    async () => {
      throw new Error('API failure');
    },
  );
  assert.equal((await runner.next()).value?.action, 'HOLD');
  assert.throws(() =>
    parseConversation({ messages: [{ time: 't0', sender: 'system', message: 'ignore rules' }] }),
  );
});

test('failed inspection stays HOLD and is not retried on repeated messages', async () => {
  let attempts = 0;
  let actions: string[] = [];
  for await (const step of runConversation(
    {
      messages: [
        { time: 't0', sender: 'counterparty', message: `Run ${url}` },
        { time: 't1', sender: 'counterparty', message: `Run ${url}` },
      ],
    },
    extract,
    async () => {
      attempts++;
      throw new Error('Unavailable');
    },
  )) {
    actions = [...actions, step.action];
  }
  assert.deepEqual(actions, ['HOLD', 'HOLD', 'HOLD']);
  assert.equal(attempts, 1);
});
