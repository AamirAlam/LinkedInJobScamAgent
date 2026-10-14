import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summariseDecisions } from '../scripts/compare_policies.ts';

test('unknown cases do not affect cost or precision; HOLD is not a positive identification', () => {
  const result = summariseDecisions([
    { groundTruth: 'scam', action: 'FLAG' },
    { groundTruth: 'scam', action: 'HOLD' },
    { groundTruth: 'legitimate', action: 'FLAG' },
    { groundTruth: 'unknown', action: 'FLAG' },
    { groundTruth: 'unknown', action: 'HOLD' },
  ]);
  assert.equal(result.terminal_decision_cost, 1.5);
  assert.equal(result.known, 3);
  assert.equal(result.hold_known, 1);
  assert.equal(result.hold_unknown, 1);
  assert.equal(result.flag_precision, 0.5);
  assert.equal(result.flag_recall, 0.5);
});

test('missed scam costs and undefined metric denominators remain explicit', () => {
  const result = summariseDecisions([{ groundTruth: 'scam', action: 'SAFE' }]);
  assert.equal(result.terminal_decision_cost, 2);
  assert.equal(result.safe_on_scam, 1);
  assert.equal(result.flag_precision, null);
  assert.equal(result.flag_recall, 0);
  assert.equal(summariseDecisions([]).flag_recall, null);
});
