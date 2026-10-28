import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fitEstimationBelief } from '../fit-belief-model.ts';
import { createEvaluationPartition } from '../evaluation-partition.ts';
import { calculateScamProbability } from '../bayes.ts';

const sourceFile = 'data/synthesis/synthetic-benchmark-100.json';
const rawSource = readFileSync(sourceFile, 'utf8');
const rawPartition = readFileSync(
  'data/synthesis/partitions/week2-v2-retrospective-v1.json',
  'utf8',
);

test('fit uses estimation counts only, excludes unknowns and preserves unsupported zero outcomes', () => {
  const fitted = fitEstimationBelief(rawSource, sourceFile, rawPartition);
  assert.equal(fitted.model.priorScam, 8 / 63);
  assert.equal(fitted.model.executionLikelihoods.likelihoodGivenScam, 5 / 8);
  assert.equal(fitted.model.executionLikelihoods.likelihoodGivenLegitimate, 20 / 55);
  assert.equal(fitted.audit.estimation_case_ids.length, 66);
  assert.equal(fitted.audit.evaluation_case_ids_excluded.length, 34);
  assert.equal(fitted.audit.unknown_estimation_case_ids_excluded.length, 3);
  assert.deepEqual(fitted.audit.zero_in_both_groups, ['unresolved']);
  const unresolved = fitted.model.firstInspectionLikelihoods['repository_inspection:unresolved']!;
  assert.equal(
    calculateScamProbability(
      fitted.model.priorScam,
      unresolved.likelihoodGivenScam,
      unresolved.likelihoodGivenLegitimate,
    ),
    'unsupported_evidence',
  );
  assert.equal(fitted.audit.deployment_validated, false);
});

test('changing evaluation labels does not alter fitted rates or training counts', () => {
  // This mutation exists only in this test; historical files are not changed.
  const source: { cases: { evaluation_id: number; evaluator_only: { ground_truth: string } }[] } =
    JSON.parse(rawSource);
  const evaluationIds = createEvaluationPartition(rawSource, sourceFile).partitions.evaluation
    .case_ids;
  const changed = JSON.stringify({
    ...source,
    cases: source.cases.map((scenario) =>
      evaluationIds.includes(scenario.evaluation_id)
        ? { ...scenario, evaluator_only: { ...scenario.evaluator_only, ground_truth: 'unknown' } }
        : scenario,
    ),
  });
  const changedPartition = JSON.stringify(createEvaluationPartition(changed, sourceFile));
  const originalFit = fitEstimationBelief(rawSource, sourceFile, rawPartition);
  const changedFit = fitEstimationBelief(changed, sourceFile, changedPartition);
  assert.equal(originalFit.model.priorScam, changedFit.model.priorScam);
  assert.deepEqual(originalFit.model.executionLikelihoods, changedFit.model.executionLikelihoods);
  assert.deepEqual(
    originalFit.model.firstInspectionLikelihoods,
    changedFit.model.firstInspectionLikelihoods,
  );
  assert.deepEqual(originalFit.audit.counts, changedFit.audit.counts);
});

test('fit rejects source tampering and does not borrow missing classes from evaluation', () => {
  assert.throws(
    () => fitEstimationBelief(`${rawSource}\n`, sourceFile, rawPartition),
    /does not match/,
  );
  const source: { cases: { evaluation_id: number; evaluator_only: { ground_truth: string } }[] } =
    JSON.parse(rawSource);
  const estimationIds = createEvaluationPartition(rawSource, sourceFile).partitions.estimation
    .case_ids;
  const changed = JSON.stringify({
    ...source,
    cases: source.cases.map((scenario) =>
      estimationIds.includes(scenario.evaluation_id)
        ? {
            ...scenario,
            evaluator_only: { ...scenario.evaluator_only, ground_truth: 'legitimate' },
          }
        : scenario,
    ),
  });
  assert.throws(
    () =>
      fitEstimationBelief(
        changed,
        sourceFile,
        JSON.stringify(createEvaluationPartition(changed, sourceFile)),
      ),
    /Both known-label groups/,
  );
});
