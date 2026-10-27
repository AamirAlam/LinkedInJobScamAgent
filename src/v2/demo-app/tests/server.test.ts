import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as requestHttp } from 'node:http';
import { createDemoServer } from '../server.ts';
import { createChatSession } from '../agent-adapter.ts';
import { noWalletRequests } from '../../tests/fixtures.ts';

const chat = { messages: [{ time: 't0', sender: 'recruiter', message: 'Hello' }] };

test('chat API appends one message, retains context, rejects unknown sessions and resets cleanly', async () => {
  let calls = 0;
  const server = createDemoServer(undefined, () =>
    createChatSession({
      extractWallet: noWalletRequests,
      extract: async () => {
        calls += 1;
        return {
          status: 'absent_so_far',
          first_explicit_request_message: null,
          supporting_message: null,
          quote: null,
          reason: 'No request in this fixture.',
        };
      },
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const submit = (body: unknown, method = 'POST') =>
    fetch(`${base}/api/chat`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const readEvents = async (response: Response) =>
    (await response.text())
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line));
  try {
    const first = await readEvents(
      await submit({ message: { sender: 'recruiter', message: 'Hello', ground_truth: 'scam' } }),
    );
    const sessionId: string = first[0].session_id;
    assert.equal(first[0].message.time, 't0');
    assert.equal(first[1].step.action, 'SAFE');
    assert.deepEqual(Object.keys(first[0].message).toSorted(), ['message', 'sender', 'time']);
    const second = await readEvents(
      await submit({
        session_id: sessionId,
        message: { sender: 'candidate', message: 'Tell me more' },
      }),
    );
    assert.equal(second[0].session_id, sessionId);
    assert.equal(second[0].message.time, 't1');
    assert.equal(second.filter((event) => event.type === 'decision').length, 1);
    assert.equal(calls, 1);
    assert.equal(
      (await submit({ message: { sender: 'system', message: 'Not allowed' } })).status,
      400,
    );
    assert.equal(
      (
        await submit({
          session_id: '00000000-0000-4000-8000-000000000000',
          message: { sender: 'recruiter', message: 'Hello' },
        })
      ).status,
      410,
    );
    assert.equal((await submit({ session_id: sessionId }, 'DELETE')).status, 204);
    assert.equal(
      (await submit({ session_id: sessionId, message: { sender: 'candidate', message: 'Hello' } }))
        .status,
      410,
    );
    assert.equal(calls, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('demo streams ordered decisions, strips labels and serves only allowlisted assets', async () => {
  let received: unknown;
  const server = createDemoServer(async function* (input) {
    received = input;
    yield { time: 't0', action: 'HOLD', reason: 'Inspecting' };
    yield { time: 't0', action: 'FLAG', reason: 'Fixture finding, not a live inspection' };
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Recruitment Guardian/);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/demo.js`)).status, 200);
    const exampleResponse = await fetch(`${base}/real-examples.json`);
    assert.equal(exampleResponse.status, 200);
    const examples: unknown = await exampleResponse.json();
    assert.ok(Array.isArray(examples));
    assert.deepEqual(
      examples.map((example) => example.source.evaluation_id),
      [44, 2],
    );
    assert.equal(examples[0].label_status, 'suspected');
    assert.match(examples[0].message, /https:\/\/github\.com\/bitangels-lab\/auron\//);
    assert.match(examples[0].adaptation, /not present in the source conversation/);
    const response = await fetch(`${base}/api/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({
        ...chat,
        ground_truth: 'scam',
        messages: chat.messages.map((message) => ({ ...message, labelEvidence: 'secret label' })),
      }),
    });
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line));
    assert.equal(response.status, 200);
    assert.deepEqual(
      events.map((event) => event.type),
      ['started', 'decision', 'decision', 'complete'],
    );
    assert.deepEqual(
      events.filter((event) => event.step).map((event) => event.step.action),
      ['HOLD', 'FLAG'],
    );
    assert.deepEqual(received, { messages: [{ ...chat.messages[0], sender: 'counterparty' }] });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('demo rejects cross-origin, oversized and invalid input before calling the runner', async () => {
  let calls = 0;
  const server = createDemoServer(async function* () {
    calls += 1;
    yield {};
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  try {
    assert.equal(
      (await post(JSON.stringify(chat), { Origin: 'https://other.invalid' })).status,
      403,
    );
    // fetch normalises Host; use HTTP directly to exercise DNS-rebinding protection.
    const wrongHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = requestHttp(
        `${base}/api/replay`,
        {
          method: 'POST',
          headers: { Host: 'other.invalid', 'Content-Type': 'application/json' },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify(chat));
    });
    assert.equal(wrongHostStatus, 403);
    assert.equal((await post('{}')).status, 400);
    assert.equal((await post('{')).status, 400);
    assert.equal(
      (
        await post(
          JSON.stringify({
            messages: Array.from({ length: 21 }, (_, index) => ({
              time: `t${index}`,
              sender: 'candidate',
              message: 'Hi',
            })),
          }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await post(
          JSON.stringify({ messages: [{ ...chat.messages[0], message: 'x'.repeat(65536) }] }),
        )
      ).status,
      400,
    );
    assert.equal((await post(JSON.stringify(chat), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal(calls, 0);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('demo admits one replay at a time, streams before completion and sanitises failures', async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createDemoServer(async function* () {
    yield { time: 't0', action: 'HOLD' };
    await pending;
    throw new Error('private credential must not reach client');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = () =>
    fetch(`${base}/api/replay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chat),
    });
  try {
    const response = await post();
    assert.equal(response.status, 200);
    assert.equal((await post()).status, 409);
    release();
    const body = await response.text();
    assert.match(body, /"type":"decision"/);
    assert.match(body, /"type":"error"/);
    assert.doesNotMatch(body, /private credential/);
    assert.doesNotMatch(body, /"type":"complete"/);
    assert.equal((await post()).status, 200);
  } finally {
    release();
    server.close();
    await once(server, 'close');
  }
});
