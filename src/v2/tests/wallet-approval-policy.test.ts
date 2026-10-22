import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  initialWalletApprovalState,
  recordWalletApprovalRequest,
  recordWalletApprovalInspection,
  applyWalletApprovalGate,
} from '../wallet-approval-policy.ts';
import type { VisibleMessage } from '../execution-extractor.ts';

const artifact = 'https://assessment.example.invalid/starter';
const messages: VisibleMessage[] = [
  { time: 'e3', sender: 'counterparty', message: `Please run the assessment in ${artifact}.` },
  {
    time: 'e6',
    sender: 'counterparty',
    message: 'Connect your personal funded wallet and approve token-spending permission.',
  },
];
const request = { artifact, message_id: 'e6', quote: messages[1].message };
const allowedRepository = {
  action: 'SAFE' as const,
  reason: 'Inspected and authorised repository scope.',
};
const check = {
  check: 'wallet_approval_inspection',
  artifact,
  requested_after_event: 'e6',
  outcome: 'harmful_behaviour_found',
  finding: 'Synthetic unrelated unrestricted spender finding; no real wallet inspected.',
};

test('no wallet request preserves the repository recommendation unchanged', () => {
  assert.strictEqual(
    applyWalletApprovalGate(initialWalletApprovalState, allowedRepository),
    allowedRepository,
  );
});

test('a current wallet permission request invalidates repository-only clearance and keeps initial state immutable', () => {
  const state = recordWalletApprovalRequest(initialWalletApprovalState, request, messages);
  assert.equal(applyWalletApprovalGate(state, allowedRepository).action, 'HOLD');
  assert.equal(initialWalletApprovalState.request, null);
  assert.equal(state.inspection, 'pending');
  assert.strictEqual(recordWalletApprovalRequest(state, request, messages), state);
  assert.throws(() =>
    recordWalletApprovalRequest(state, { ...request, artifact: artifact + '/different' }, [
      ...messages,
      { time: 'e7', sender: 'counterparty', message: artifact + '/different' },
    ]),
  );
});

test('wallet annotations reject future, candidate-only, fabricated and unbound artifact evidence', () => {
  assert.throws(() =>
    recordWalletApprovalRequest(initialWalletApprovalState, request, messages.slice(0, 1)),
  );
  assert.throws(() =>
    recordWalletApprovalRequest(initialWalletApprovalState, request, [
      messages[0],
      { ...messages[1], sender: 'candidate' },
    ]),
  );
  assert.throws(() =>
    recordWalletApprovalRequest(
      initialWalletApprovalState,
      { ...request, quote: 'invented quote' },
      messages,
    ),
  );
  assert.throws(() =>
    recordWalletApprovalRequest(
      initialWalletApprovalState,
      { ...request, artifact: 'https://other.example.invalid/' },
      messages,
    ),
  );
});

test('wallet results require a prior same-artifact same-request record', () => {
  assert.throws(() => recordWalletApprovalInspection(initialWalletApprovalState, check));
  const state = recordWalletApprovalRequest(initialWalletApprovalState, request, messages);
  assert.throws(() =>
    recordWalletApprovalInspection(state, { ...check, artifact: artifact + '/other' }),
  );
  assert.throws(() =>
    recordWalletApprovalInspection(state, { ...check, requested_after_event: 'e9' }),
  );
  assert.throws(() => recordWalletApprovalInspection(state, { ...check, finding: ' ' }));
});

test('clean or unresolved wallet results alone cannot authorise spending', () => {
  const state = recordWalletApprovalRequest(initialWalletApprovalState, request, messages);
  for (const outcome of ['no_harmful_behaviour_found', 'unresolved']) {
    const updated = recordWalletApprovalInspection(state, { ...check, outcome });
    assert.equal(applyWalletApprovalGate(updated, allowedRepository).action, 'HOLD');
  }
});

test('harm remains FLAG through a later clean result and another request', () => {
  const pending = recordWalletApprovalRequest(initialWalletApprovalState, request, messages);
  const harmful = recordWalletApprovalInspection(pending, check);
  const clean = recordWalletApprovalInspection(harmful, {
    ...check,
    outcome: 'no_harmful_behaviour_found',
  });
  assert.equal(applyWalletApprovalGate(clean, allowedRepository).action, 'FLAG');
  const nextMessages: VisibleMessage[] = [
    ...messages,
    { time: 'e8', sender: 'counterparty', message: 'Please approve again.' },
  ];
  const later = recordWalletApprovalRequest(
    clean,
    { ...request, message_id: 'e8', quote: 'approve again' },
    nextMessages,
  );
  assert.equal(later.inspection, 'pending');
  assert.equal(applyWalletApprovalGate(later, allowedRepository).action, 'FLAG');
  assert.equal(
    applyWalletApprovalGate(initialWalletApprovalState, {
      action: 'FLAG',
      reason: 'Earlier repository harm.',
    }).action,
    'FLAG',
  );
});
