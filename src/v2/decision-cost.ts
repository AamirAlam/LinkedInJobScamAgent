import { isValidProbability } from './bayes.ts';

export type Action = 'SAFE' | 'HOLD' | 'FLAG';
export type DecisionCosts = Readonly<Record<Action, Readonly<{ scam: number; legitimate: number }>>>;

// Costs must share a unit and decision horizon. No default domain costs.
// This calculation does not override repository safety constraints.
export function selectLowestCostActions(scamProbability: number, costs: DecisionCosts) {
    if (!isValidProbability(scamProbability)) {
        throw new RangeError('Scam probability must be finite and between 0 and 1.');
    }
    const actions: Action[] = ['SAFE', 'HOLD', 'FLAG'];
    const expectedCosts = {} as Record<Action, number>;
    for (const action of actions) {
        const row = costs?.[action];
        if (!row || ![row.scam, row.legitimate].every(value => Number.isFinite(value) && value >= 0)) {
            throw new RangeError('Every action requires finite, non-negative costs for both states.');
        }
        expectedCosts[action] = scamProbability * row.scam + (1 - scamProbability) * row.legitimate;
    }
    const minimumCost = Math.min(...Object.values(expectedCosts));
    // Relative floating-point tolerance preserves ties at calculated boundaries.
    const optimalActions = actions.filter(action =>
        Math.abs(expectedCosts[action] - minimumCost) <=
        8 * Number.EPSILON * Math.max(Math.abs(expectedCosts[action]), Math.abs(minimumCost)));
    return { expectedCosts, minimumCost, optimalActions };
}
