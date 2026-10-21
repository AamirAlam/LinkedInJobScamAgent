import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareAssessmentAuthorisation } from '../assessment-authorisation.ts';
import { runConversation } from '../conversation-runner.ts';
import { runRepositoryInspection } from '../repository-inspection-cycle.ts';
import type { ExecutionAnnotation, VisibleMessage } from '../execution-extractor.ts';

const artifact = 'https://github.com/example/demo';
const message = `Run npm run dev in ${artifact}`;
type Cycle = Awaited<ReturnType<typeof runRepositoryInspection>>;
async function cycle(
  outcome: Cycle['inspection']['outcome'] = 'no_harmful_behaviour_found',
): Promise<Cycle> {
  const base = await runRepositoryInspection(artifact, message, {
    fetcher: (async () => new Response('', { status: 404 })) as typeof fetch,
  });
  return {
    ...base,
    inspection: {
      ...base.inspection,
      outcome,
      scope: {
        inspection_boundary: 'repository_controlled_code',
        requested_action: message,
        artifact_revision: 'a'.repeat(40),
        inspected_files: ['package.json'],
        findings:
          outcome === 'harmful_behaviour_found'
            ? [
                {
                  file: 'package.json',
                  start_line: 1,
                  end_line: 1,
                  quote: '{}',
                  behaviour: 'Synthetic harmful fixture.',
                  harmful: true,
                },
              ]
            : [],
        gaps: outcome === 'unresolved' ? ['Unresolved fixture path.'] : [],
      },
    },
  };
}
function authorisation(rawSource: string) {
  const prepared = prepareAssessmentAuthorisation(rawSource, 'fixture.json');
  return {
    rawSource,
    sourcePath: 'fixture.json',
    rawRecord: JSON.stringify({
      ...prepared,
      status: 'completed_verification',
      outcome: 'verified',
      verification: {
        reviewer: 'Synthetic reviewer',
        reviewed_at: '2020-01-01T00:00:00Z',
        organisation: 'Fixture company',
        requester: 'Fixture recruiter',
        independent_channel: 'independent_company_contact',
        evidence_reference: 'fixture-evidence',
        evidence_summary: 'Synthetic independent confirmation.',
        identity_confirmed: true,
        authority_confirmed: true,
        action_confirmed: true,
      },
    }),
  };
}
const extract = async (messages: readonly VisibleMessage[]): Promise<ExecutionAnnotation> => {
  assert.ok(
    messages.every((item) => Object.keys(item).toSorted().join(',') === 'message,sender,time'),
  );
  return {
    status: 'present',
    first_explicit_request_message: messages[0].time,
    supporting_message: messages[0].time,
    quote: messages[0].message,
    reason: 'Explicit fixture execution request.',
  };
};
const conversation = {
  messages: [
    { time: 't0', sender: 'counterparty', message },
    { time: 't1', sender: 'counterparty', message: 'Now run another program.' },
  ],
};

test('bound authorisation permits the inspected request with precautions, then later instructions return to HOLD', async () => {
  const inspected = await cycle();
  let calls = 0;
  let steps = [] as Array<{ action: string; authorisation_status?: string; precautions?: unknown }>;
  for await (const step of runConversation(
    conversation,
    extract,
    async () => {
      calls++;
      return inspected;
    },
    authorisation(JSON.stringify(inspected)),
  )) {
    steps = [...steps, step];
  }
  assert.deepEqual(
    steps.map((step) => step.action),
    ['HOLD', 'SAFE', 'HOLD'],
  );
  assert.equal(steps[1].authorisation_status, 'verified');
  assert.ok(Array.isArray(steps[1].precautions));
  assert.equal(calls, 1);
});

test('changed live revision, artifact or command cannot reuse authorisation', async () => {
  const inspected = await cycle();
  const approval = authorisation(JSON.stringify(inspected));
  assert.ok(inspected.inspection.scope);
  const scope = inspected.inspection.scope;
  const variants: Cycle[] = [
    {
      ...inspected,
      inspection: { ...inspected.inspection, artifact: 'https://github.com/other/repo' },
    },
    ...['artifact_revision', 'requested_action'].map((field) => ({
      ...inspected,
      inspection: {
        ...inspected.inspection,
        scope: { ...scope, [field]: 'changed' },
      },
    })),
  ];
  for (const variant of variants) {
    let actions: string[] = [];
    for await (const step of runConversation(
      conversation,
      extract,
      async () => variant,
      approval,
    )) {
      actions = [...actions, step.action];
    }
    assert.deepEqual(actions, ['HOLD', 'HOLD', 'HOLD']);
  }
  const changedMessage = {
    messages: [{ time: 't0', sender: 'counterparty', message: `Run npm test in ${artifact}` }],
  };
  let actions: string[] = [];
  for await (const step of runConversation(
    changedMessage,
    extract,
    async () => inspected,
    approval,
  )) {
    actions = [...actions, step.action];
  }
  assert.deepEqual(actions, ['HOLD', 'HOLD']);
});

test('harm from the live inspection or the matching saved assessment remains FLAG', async () => {
  const clean = await cycle();
  const harmful = await cycle('harmful_behaviour_found');
  for (const [live, historical] of [
    [harmful, clean],
    [clean, harmful],
  ]) {
    let actions: string[] = [];
    for await (const step of runConversation(
      conversation,
      extract,
      async () => live,
      authorisation(JSON.stringify(historical)),
    )) {
      actions = [...actions, step.action];
    }
    assert.deepEqual(actions, ['HOLD', 'FLAG', 'FLAG']);
  }
});

test('invalid pending evidence is rejected before extraction or source requests', async () => {
  const rawSource = JSON.stringify(await cycle());
  const pending = {
    rawSource,
    sourcePath: 'fixture.json',
    rawRecord: JSON.stringify(prepareAssessmentAuthorisation(rawSource, 'fixture.json')),
  };
  const runner = runConversation(
    conversation,
    async () => assert.fail('No model work'),
    async () => assert.fail('No source work'),
    pending,
  );
  await assert.rejects(runner.next());
});

test('authorisation can bind to a completed conversation report containing exactly one inspection', async () => {
  const inspected = await cycle();
  const raw = JSON.stringify({
    purpose: 'conversation_driven_repository_inspection',
    status: 'complete',
    steps: [{ inspection: inspected }],
  });
  let actions: string[] = [];
  for await (const step of runConversation(
    conversation,
    extract,
    async () => inspected,
    authorisation(raw),
  )) {
    actions = [...actions, step.action];
  }
  assert.deepEqual(actions, ['HOLD', 'SAFE', 'HOLD']);
  const ambiguous = JSON.stringify({
    purpose: 'conversation_driven_repository_inspection',
    status: 'complete',
    steps: [{ inspection: inspected }, { inspection: inspected }],
  });
  assert.throws(() => authorisation(ambiguous), /exactly one inspection/);
});

test('delayed recognition of an earlier approved request cannot release a later unassessed message', async () => {
  const inspected = await cycle();
  let actions: string[] = [];
  for await (const step of runConversation(
    conversation,
    async (prefix) => {
      if (prefix.length === 1) {
        throw new Error('Synthetic first-message extraction failure.');
      }
      return extract(prefix);
    },
    async () => inspected,
    authorisation(JSON.stringify(inspected)),
  )) {
    actions = [...actions, step.action];
  }
  assert.deepEqual(actions, ['HOLD', 'HOLD', 'HOLD']);
});
