import { selectLowestCostActions } from './decision-cost.ts';
import { recommendRepositoryAction } from './repository-policy.ts';
import type { RepositoryAssessment } from './repository-policy.ts';

// Student-assumed relative costs for ordinary hiring, not measured losses.
// HOLD means up to 24 hours without executing code or sharing sensitive data.
// Urgent deadlines require a separate cost model.
export const ordinaryHiringCosts = Object.freeze({
  SAFE: Object.freeze({ scam: 2, legitimate: 0 }),
  HOLD: Object.freeze({ scam: 0.5, legitimate: 0.5 }),
  FLAG: Object.freeze({ scam: 0, legitimate: 1 }),
});

/** Choose an action using assumed ordinary-hiring costs, HOLD tie-breaking, and repository constraints. */
export function recommendOrdinaryHiringAction(
  scamProbability: number,
  repository?: RepositoryAssessment,
) {
  const calculation = selectLowestCostActions(scamProbability, ordinaryHiringCosts);
  const costAction = calculation.optimalActions.includes('HOLD')
    ? 'HOLD'
    : calculation.optimalActions[0];
  const repositoryRecommendation = repository ? recommendRepositoryAction(repository) : null;
  // An unresolved execution request prevents SAFE; concrete harm requires FLAG.
  const action =
    repositoryRecommendation?.action === 'FLAG'
      ? 'FLAG'
      : costAction === 'SAFE' && repositoryRecommendation?.action === 'HOLD'
        ? 'HOLD'
        : costAction;
  return {
    ...calculation,
    costAction,
    action,
    safetyOverride: action !== costAction,
    repositoryRecommendation,
    // Minimum cost describes the unconstrained cost action, not an override.
    selectedExpectedCost: calculation.expectedCosts[action],
  };
}
