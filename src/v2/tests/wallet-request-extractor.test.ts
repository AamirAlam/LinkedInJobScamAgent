import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  validateWalletRequestAnnotation,
  walletOutputSchema,
} from '../wallet-request-extractor.ts';
import type { VisibleMessage } from '../execution-extractor.ts';

const messages: VisibleMessage[] = [
  { time: 't0', sender: 'candidate', message: 'Should I approve my wallet?' },
  { time: 't1', sender: 'counterparty', message: 'Please approve token spending in the demo.' },
];
const present = {
  status: 'present',
  message_id: 't1',
  quote: 'approve token spending',
  reason: 'Visible fixture permission request.',
};

test('wallet annotations require exact arrived counterparty evidence', () => {
  assert.equal(validateWalletRequestAnnotation(present, messages).message_id, 't1');
  assert.throws(() => validateWalletRequestAnnotation(present, messages.slice(0, 1)));
  assert.throws(() =>
    validateWalletRequestAnnotation(
      { ...present, message_id: 't0', quote: 'approve my wallet' },
      messages,
    ),
  );
  assert.throws(() => validateWalletRequestAnnotation({ ...present, quote: 'invented' }, messages));
  assert.throws(() => validateWalletRequestAnnotation({ ...present, reason: ' ' }, messages));
});

test('absent status cannot carry a request; schema rejects probabilities or actions', () => {
  const absent = {
    status: 'absent_so_far',
    message_id: null,
    quote: null,
    reason: 'No request in fixture.',
  };
  assert.equal(validateWalletRequestAnnotation(absent, messages).status, 'absent_so_far');
  assert.throws(() => validateWalletRequestAnnotation({ ...absent, message_id: 't1' }, messages));
  assert.throws(() => walletOutputSchema.parse({ annotation: { ...present, scamProbability: 1 } }));
  assert.throws(() => walletOutputSchema.parse({ annotation: { ...present, action: 'FLAG' } }));
});
