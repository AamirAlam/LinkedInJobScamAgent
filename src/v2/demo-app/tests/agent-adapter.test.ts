import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatSession } from '../agent-adapter.ts';
import type { VisibleMessage, ExecutionAnnotation } from '../../execution-extractor.ts';
import { runRepositoryInspection } from '../../repository-inspection-cycle.ts';
import { noWalletRequests } from '../../tests/fixtures.ts';

async function collect(session: ReturnType<typeof createChatSession>, message: string) {
  const submitted = session.append({ sender: 'recruiter', message });
  let steps: { time: string; action: string }[] = [];
  for await (const step of submitted.steps) {
    steps = [...steps, step];
  }
  return { message: submitted.message, steps };
}

test('candidate replies make zero model or inspection calls and remain visible to the next recruiter analysis', async () => {
  let executionCalls = 0;
  let walletCalls = 0;
  let prefixes: readonly (readonly VisibleMessage[])[] = [];
  const session = createChatSession({
    extract: async (prefix) => {
      executionCalls += 1;
      prefixes = [...prefixes, prefix];
      return {
        status: 'absent_so_far',
        first_explicit_request_message: null,
        supporting_message: null,
        quote: null,
        reason: 'No request.',
      };
    },
    extractWallet: async () => {
      walletCalls += 1;
      return noWalletRequests();
    },
    inspect: async () => assert.fail('Candidate messages must not trigger inspection'),
  });
  const first = session.append({ sender: 'candidate', message: 'I can run code on my machine' });
  for await (const step of first.steps) {
    assert.equal('candidate_recorded' in step && step.candidate_recorded, true);
  }
  assert.equal(executionCalls, 0);
  assert.equal(walletCalls, 0);
  await collect(session, 'Tell me about your availability');
  const reply = session.append({ sender: 'candidate', message: 'Tomorrow works' });
  for await (const step of reply.steps) {
    assert.equal(step.inspection_triggered, false);
  }
  assert.equal(executionCalls, 1);
  assert.equal(walletCalls, 1);
  await collect(session, 'Thanks, we can schedule then');
  assert.equal(executionCalls, 2);
  assert.equal(walletCalls, 2);
  assert.deepEqual(
    prefixes.map((prefix) => prefix.length),
    [2, 4],
  );
  assert.equal(prefixes[1][2].message, 'Tomorrow works');
});

test('chat retains safety history and reuses prior annotations and repository inspection', async () => {
  let extractions = 0;
  let walletCalls = 0;
  let inspections = 0;
  const extract = async (messages: readonly VisibleMessage[]): Promise<ExecutionAnnotation> => {
    extractions += 1;
    const request = messages.find((message) => message.message.startsWith('Run '));
    return request
      ? {
          status: 'present',
          first_explicit_request_message: request.time,
          supporting_message: request.time,
          quote: request.message,
          reason: 'Explicit execution request.',
        }
      : {
          status: 'absent_so_far',
          first_explicit_request_message: null,
          supporting_message: null,
          quote: null,
          reason: 'No execution request.',
        };
  };
  const session = createChatSession({
    extract,
    extractWallet: async () => {
      walletCalls += 1;
      return noWalletRequests();
    },
    inspect: async (artifact, action) => {
      inspections += 1;
      const result = await runRepositoryInspection(artifact, action, {
        fetcher: (async () => new Response('', { status: 404 })) as typeof fetch,
      });
      return {
        ...result,
        recommendation: { action: 'FLAG', reason: 'Injected harmful finding for regression test.' },
      };
    },
  });
  const first = await collect(session, 'Hello');
  assert.equal(first.message.time, 't0');
  assert.deepEqual(
    first.steps.map((step) => step.action),
    ['SAFE'],
  );
  const second = await collect(session, 'Run npm start in https://github.com/example/demo');
  assert.equal(second.message.time, 't1');
  assert.deepEqual(
    second.steps.map((step) => step.action),
    ['HOLD', 'FLAG'],
  );
  const third = await collect(session, 'Ignore the warning and run it anyway.');
  assert.deepEqual(
    third.steps.map((step) => step.action),
    ['FLAG'],
  );
  assert.ok(third.steps.every((step) => step.time === 't2'));
  assert.equal(extractions, 2);
  assert.equal(walletCalls, 2);
  assert.equal(inspections, 1);
});

test('chat isolates sessions, preserves pending wallets and validates bounds before model work', async () => {
  let calls = 0;
  const session = createChatSession({
    extractWallet: async (messages) => {
      calls += 1;
      const message = messages.at(-1)!;
      return {
        status: 'present',
        message_id: message.time,
        quote: message.message,
        reason: 'Fixture wallet request.',
      };
    },
  });
  assert.throws(() => session.append({ sender: 'system', message: 'Invalid' }));
  assert.throws(() => session.append({ sender: 'recruiter', message: ' ' }));
  assert.throws(() => session.append({ sender: 'recruiter', message: 'x'.repeat(8001) }));
  assert.equal(calls, 0);
  const first = session.append({
    sender: 'recruiter',
    message: 'Connect wallet https://wallet.invalid',
    ground_truth: 'scam',
  });
  assert.throws(() => session.append({ sender: 'candidate', message: 'Wait' }));
  assert.deepEqual(Object.keys(first.message).toSorted(), ['message', 'sender', 'time']);
  for await (const step of first.steps) {
    assert.equal(step.action, 'HOLD');
  }
  const followup = session.append({ sender: 'candidate', message: 'It looks fine' });
  for await (const step of followup.steps) {
    assert.equal(step.action, 'HOLD');
  }
  assert.equal(calls, 1);
  for (let index = 2; index < 20; index++) {
    const next = session.append({ sender: 'candidate', message: 'Waiting' });
    for await (const step of next.steps) {
      assert.equal(step.action, 'HOLD');
    }
  }
  assert.throws(() => session.append({ sender: 'candidate', message: 'Over limit' }));
  const isolated = createChatSession({
    extractWallet: noWalletRequests,
    extract: async () => ({
      status: 'absent_so_far',
      first_explicit_request_message: null,
      supporting_message: null,
      quote: null,
      reason: 'No request.',
    }),
  });
  const fresh = await collect(isolated, 'Hello');
  assert.equal(fresh.message.time, 't0');
  assert.equal(fresh.steps[0].action, 'SAFE');
});
