import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runConversation } from '../conversation-runner.ts';
import { prepareAssessmentAuthorisation } from '../assessment-authorisation.ts';
import { runRepositoryInspection } from '../repository-inspection-cycle.ts';
import { noWalletRequests } from './fixtures.ts';
import type { VisibleMessage, ExecutionAnnotation } from '../execution-extractor.ts';

const repo = 'https://github.com/example/demo';
const walletMessage = 'Please connect your funded wallet and approve token spending.';
const present = async (prefix: readonly VisibleMessage[]) => ({
  status: 'present' as const,
  message_id: prefix.at(-1)!.time,
  quote: prefix.at(-1)!.message,
  reason: 'Synthetic source-backed wallet request.',
});
const absentExecution = async (): Promise<ExecutionAnnotation> => ({
  status: 'absent_so_far',
  first_explicit_request_message: null,
  supporting_message: null,
  quote: null,
  reason: 'No execution request.',
});

test('direct wallet requests hold without repository fetch and never expose labels to the annotator', async () => {
  let steps = [] as Array<{ action: string; scope: string }>;
  for await (const step of runConversation(
    {
      messages: [
        {
          time: 't0',
          sender: 'recruiter',
          message: `${walletMessage} https://demo.example.invalid/verify`,
          ground_truth: 'scam',
        },
      ],
    },
    async () => assert.fail('No repository extraction'),
    async () => assert.fail('No repository fetch'),
    undefined,
    async (prefix) => {
      assert.deepEqual(Object.keys(prefix[0]).toSorted(), ['message', 'sender', 'time']);
      return present(prefix);
    },
  )) {
    steps = [...steps, step];
  }
  assert.equal(steps[0].action, 'HOLD');
  assert.equal(steps[0].scope, 'wallet_approval');
});

test('unbound, ambiguous and invalid wallet evidence cannot permit execution', async () => {
  for (const [index, extractor] of [
    present,
    async (prefix: readonly VisibleMessage[]) => ({
      ...(await present(prefix)),
      status: 'ambiguous' as const,
    }),
    async (prefix: readonly VisibleMessage[]) => ({
      ...(await present(prefix)),
      quote: 'fabricated',
    }),
  ].entries()) {
    let actions: string[] = [];
    for await (const step of runConversation(
      {
        messages: [
          { time: 't0', sender: 'counterparty', message: walletMessage },
          { time: 't1', sender: 'candidate', message: 'Okay' },
        ],
      },
      absentExecution,
      async () => assert.fail('No fetch'),
      undefined,
      extractor,
    )) {
      actions = [...actions, step.action];
    }
    assert.deepEqual(actions, index === 2 ? ['HOLD', 'SAFE'] : ['HOLD', 'HOLD']);
  }
});

test('candidate-only wallet text makes no wallet API call and grants conversation-only SAFE', async () => {
  const runner = runConversation(
    { messages: [{ time: 't0', sender: 'candidate', message: walletMessage }] },
    absentExecution,
    async () => assert.fail('No fetch'),
    undefined,
    async () => assert.fail('No wallet call for candidate text'),
  );
  const step = (await runner.next()).value!;
  assert.equal(step.action, 'SAFE');
  assert.equal(step.scope, 'conversation_only');
});

test('wallet detection runs after authorised repository clearance and holds the new permission', async () => {
  const request = `Run npm run dev in ${repo}`;
  const base = await runRepositoryInspection(repo, request, {
    fetcher: (async () => new Response('', { status: 404 })) as typeof fetch,
  });
  const inspected = {
    ...base,
    inspection: {
      ...base.inspection,
      outcome: 'no_harmful_behaviour_found' as const,
      scope: {
        inspection_boundary: 'repository_controlled_code' as const,
        requested_action: request,
        artifact_revision: 'a'.repeat(40),
        inspected_files: ['package.json'],
        findings: [],
        gaps: [],
      },
    },
  };
  const rawSource = JSON.stringify(inspected);
  const rawRecord = JSON.stringify({
    ...prepareAssessmentAuthorisation(rawSource, 'fixture.json'),
    status: 'completed_verification',
    outcome: 'verified',
    verification: {
      reviewer: 'Synthetic fixture',
      reviewed_at: '2020-01-01T00:00:00Z',
      organisation: 'Fixture company',
      requester: 'Fixture recruiter',
      independent_channel: 'independent_company_contact',
      evidence_reference: 'fixture',
      evidence_summary: 'Synthetic independent confirmation.',
      identity_confirmed: true,
      authority_confirmed: true,
      action_confirmed: true,
    },
  });
  const extractor = async (prefix: readonly VisibleMessage[]): Promise<ExecutionAnnotation> => ({
    status: 'present',
    first_explicit_request_message: 't0',
    supporting_message: 't0',
    quote: prefix[0].message,
    reason: 'Explicit fixture request.',
  });
  let steps = [] as Array<{ action: string; scope: string }>;
  for await (const step of runConversation(
    {
      messages: [
        { time: 't0', sender: 'counterparty', message: request },
        { time: 't1', sender: 'counterparty', message: walletMessage },
      ],
    },
    extractor,
    async () => inspected,
    { rawSource, rawRecord, sourcePath: 'fixture.json' },
    async (prefix) => (prefix.length === 1 ? noWalletRequests() : present(prefix)),
  )) {
    steps = [...steps, step];
  }
  assert.deepEqual(
    steps.map((step) => step.action),
    ['HOLD', 'SAFE', 'HOLD'],
  );
  assert.equal(steps[2].scope, 'wallet_approval');
});
