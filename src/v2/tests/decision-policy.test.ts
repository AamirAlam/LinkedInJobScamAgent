import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recommendOrdinaryHiringAction } from '../decision-policy.ts';
import type { RepositoryAssessment } from '../repository-policy.ts';

test('student-assumed costs derive the boundaries and HOLD wins both ties', () => {
  for (const [probability, action] of [
    [0, 'SAFE'],
    [0.2, 'SAFE'],
    [0.249, 'SAFE'],
    [0.25, 'HOLD'],
    [0.4, 'HOLD'],
    [0.5, 'HOLD'],
    [0.501, 'FLAG'],
    [0.6, 'FLAG'],
    [1, 'FLAG'],
  ] as const) {
    const result = recommendOrdinaryHiringAction(probability);
    assert.equal(result.action, action);
    assert.equal(result.safetyOverride, false);
  }
});

test('repository constraints restrict SAFE without weakening cost-based FLAG', () => {
  const pending: RepositoryAssessment = {
    executionRequested: true,
    inspection: 'pending',
    assessmentAuthorisation: 'verified',
  };
  const held = recommendOrdinaryHiringAction(0.2, pending);
  assert.equal(held.costAction, 'SAFE');
  assert.equal(held.action, 'HOLD');
  assert.equal(held.safetyOverride, true);
  assert.equal(held.minimumCost, 0.4);
  assert.equal(held.selectedExpectedCost, 0.5);
  const clean = { ...pending, inspection: 'no_harmful_behaviour_found' as const };
  assert.equal(recommendOrdinaryHiringAction(0.2, clean).action, 'SAFE');
  assert.ok(
    recommendOrdinaryHiringAction(0.2, clean).repositoryRecommendation?.precautions?.length,
  );
  assert.equal(recommendOrdinaryHiringAction(0.9, clean).action, 'FLAG');
  assert.equal(recommendOrdinaryHiringAction(0.9, pending).action, 'FLAG');
  assert.equal(
    recommendOrdinaryHiringAction(0.01, { ...pending, inspection: 'harmful_behaviour_found' })
      .action,
    'FLAG',
  );
  assert.equal(
    recommendOrdinaryHiringAction(0.2, { ...pending, executionRequested: false }).action,
    'SAFE',
  );
});
