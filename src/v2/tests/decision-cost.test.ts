import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectLowestCostActions } from '../decision-cost.ts';
import type { DecisionCosts } from '../decision-cost.ts';

// Recorded V1 relative assumptions, not measured recruitment losses.
const costs: DecisionCosts = {
  SAFE: { scam: 10, legitimate: 0 },
  HOLD: { scam: 2, legitimate: 1 },
  FLAG: { scam: 0, legitimate: 5 },
};

test('expected costs select each action and retain boundary ties', () => {
  assert.deepEqual(selectLowestCostActions(0, costs).optimalActions, ['SAFE']);
  const middle = selectLowestCostActions(0.2, costs);
  assert.equal(middle.expectedCosts.SAFE, 2);
  assert.ok(Math.abs(middle.expectedCosts.HOLD - 1.2) < 1e-12);
  assert.equal(middle.expectedCosts.FLAG, 4);
  assert.deepEqual(middle.optimalActions, ['HOLD']);
  assert.deepEqual(selectLowestCostActions(1, costs).optimalActions, ['FLAG']);
  assert.deepEqual(selectLowestCostActions(1 / 9, costs).optimalActions, ['SAFE', 'HOLD']);
  assert.deepEqual(selectLowestCostActions(2 / 3, costs).optimalActions, ['HOLD', 'FLAG']);
});

test('higher missed-scam costs change the action without changing belief', () => {
  const revised = { ...costs, SAFE: { scam: 100, legitimate: 0 } };
  assert.deepEqual(selectLowestCostActions(0.05, costs).optimalActions, ['SAFE']);
  assert.deepEqual(selectLowestCostActions(0.05, revised).optimalActions, ['HOLD']);
  const scaled = Object.fromEntries(
    Object.entries(costs).map(([action, row]) => [
      action,
      { scam: row.scam * 0.001, legitimate: row.legitimate * 0.001 },
    ]),
  ) as DecisionCosts;
  assert.deepEqual(selectLowestCostActions(2 / 3, scaled).optimalActions, ['HOLD', 'FLAG']);
});

test('invalid inputs fail rather than producing a recommendation', () => {
  for (const value of [NaN, Infinity, -1, 2]) {
    assert.throws(() => selectLowestCostActions(value, costs), RangeError);
  }
  for (const value of [NaN, Infinity, -1]) {
    assert.throws(
      () => selectLowestCostActions(0.2, { ...costs, HOLD: { scam: value, legitimate: 1 } }),
      RangeError,
    );
  }
  assert.throws(() => selectLowestCostActions(0.2, {} as DecisionCosts), RangeError);
  const zero = {
    SAFE: { scam: 0, legitimate: 0 },
    HOLD: { scam: 0, legitimate: 0 },
    FLAG: { scam: 0, legitimate: 0 },
  };
  assert.deepEqual(selectLowestCostActions(0.2, zero).optimalActions, ['SAFE', 'HOLD', 'FLAG']);
});
