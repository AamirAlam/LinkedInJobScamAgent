import { isValidProbability } from './bayes.ts';

const TIE_TOLERANCE = 8;

export type Action = 'SAFE' | 'HOLD' | 'FLAG';
export type DecisionCosts = Readonly<
  Record<Action, Readonly<{ scam: number; legitimate: number }>>
>;

// Costs must share a unit and decision horizon. No default domain costs.
// This calculation does not override repository safety constraints.
/** Calculate expected costs in shared units and retain all actions tied within floating-point tolerance. */
export function selectLowestCostActions(scamProbability: number, costs: DecisionCosts) {
  if (!isValidProbability(scamProbability)) {
    throw new RangeError('Scam probability must be finite and between 0 and 1.');
  }
  const actions: Action[] = ['SAFE', 'HOLD', 'FLAG'];
  const entries = actions.map((action) => {
    const row = costs?.[action];
    if (
      !row ||
      ![row.scam, row.legitimate].every((value) => Number.isFinite(value) && value >= 0)
    ) {
      throw new RangeError('Every action requires finite, non-negative costs for both states.');
    }
    return [action, scamProbability * row.scam + (1 - scamProbability) * row.legitimate] as const;
  });
  const expectedCosts = Object.fromEntries(entries) as Record<Action, number>;
  const minimumCost = Math.min(...Object.values(expectedCosts));
  // Relative floating-point tolerance preserves ties at calculated boundaries.
  const optimalActions = actions.filter(
    (action) =>
      Math.abs(expectedCosts[action] - minimumCost) <=
      TIE_TOLERANCE *
        Number.EPSILON *
        Math.max(Math.abs(expectedCosts[action]), Math.abs(minimumCost)),
  );
  return { expectedCosts, minimumCost, optimalActions };
}
