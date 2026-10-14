import { z } from 'zod';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyCheckResult, applyEvidence } from '../bayes.ts';
import { recommendOrdinaryHiringAction } from '../decision-policy.ts';
import type { BeliefState } from '../bayes.ts';
import type { RepositoryAssessment } from '../repository-policy.ts';

// In-sample arithmetic demonstration, not a fitted model or held-out evaluation.
// Hidden labels are read ONLY here to reproduce the student's reviewed counts.
const source = 'data/synthesis/synthetic-benchmark-100.json';
const exerciseCaseSchema = z.object({
  evaluator_only: z.object({ ground_truth: z.string(), execution_request_status: z.string() }),
  events: z.array(
    z.object({
      kind: z.string(),
      agent_input: z.object({ check: z.string().optional(), outcome: z.string().optional() }),
    }),
  ),
});
const benchmark = z
  .object({ cases: z.array(exerciseCaseSchema) })
  .parse(JSON.parse(readFileSync(source, 'utf8')));
type Target = z.infer<typeof exerciseCaseSchema>['evaluator_only'];
const targets: Target[] = benchmark.cases.map(
  (item: { evaluator_only: Target }) => item.evaluator_only,
);
const scams = targets.filter((item) => item.ground_truth === 'scam');
const legitimate = targets.filter((item) => item.ground_truth === 'legitimate');
const executionCount = (group: Target[]) =>
  group.filter((item) => item.execution_request_status === 'present').length;
assert.deepEqual(
  [scams.length, legitimate.length, executionCount(scams), executionCount(legitimate)],
  [11, 84, 6, 21],
  'Benchmark changed: review the exercise counts before using this demo.',
);

const prior: BeliefState = {
  scamProbability: scams.length / (scams.length + legitimate.length),
  appliedEvidenceIds: [],
};
const likelihoods = {
  likelihoodGivenScam: executionCount(scams) / scams.length,
  likelihoodGivenLegitimate: executionCount(legitimate) / legitimate.length,
};
const repository: RepositoryAssessment = {
  executionRequested: true,
  inspection: 'pending',
  assessmentAuthorisation: 'unresolved',
};
// One conversation-level signal: later messages repeating it keep the same ID.
const first = applyEvidence(prior, 'exercise-conversation:execution-request', likelihoods);
const repeated = applyEvidence(first.state, 'exercise-conversation:execution-request', likelihoods);
const decision = recommendOrdinaryHiringAction(first.state.scamProbability, repository);
assert.equal(first.status, 'updated');
assert.ok(Math.abs(first.state.scamProbability - 2 / 9) < 1e-12);
assert.equal(repeated.status, 'duplicate_evidence');
assert.strictEqual(repeated.state, first.state);
assert.equal(decision.costAction, 'SAFE');
assert.equal(decision.action, 'HOLD');
assert.equal(decision.safetyOverride, true);
assert.equal(prior.appliedEvidenceIds.length, 0);

// A completed check with no configured likelihood row must not invent a posterior.
const inspectionEvent = {
  kind: 'check_result',
  agent_input: {
    check: 'repository_inspection',
    outcome: 'unresolved',
    artifact: 'exercise-repository',
  },
};
const unmodelled = applyCheckResult(first.state, inspectionEvent, {});
assert.equal(unmodelled.status, 'unmodelled_evidence');
assert.strictEqual(unmodelled.state, first.state);

// Condition on the execution request already observed. Count only the first
// attempted repository inspection per case, not later repeated check results.
function countInspectionOutcomes(state: string) {
  const results = benchmark.cases
    .filter(
      (item) =>
        item.evaluator_only.ground_truth === state &&
        item.evaluator_only.execution_request_status === 'present',
    )
    .map((item) =>
      item.events.find(
        (event) =>
          event.kind === 'check_result' && event.agent_input.check === 'repository_inspection',
      ),
    )
    .filter((event) => event !== undefined);
  return {
    attempted: results.length,
    unresolved: results.filter((event) => event.agent_input.outcome === 'unresolved').length,
    scopedClean: results.filter(
      (event) => event.agent_input.outcome === 'no_harmful_behaviour_found',
    ).length,
    harmful: results.filter((event) => event.agent_input.outcome === 'harmful_behaviour_found')
      .length,
  };
}
const scamInspections = countInspectionOutcomes('scam');
const legitimateInspections = countInspectionOutcomes('legitimate');
assert.deepEqual(
  [scamInspections, legitimateInspections],
  [
    { attempted: 6, unresolved: 1, scopedClean: 1, harmful: 4 },
    { attempted: 21, unresolved: 1, scopedClean: 20, harmful: 0 },
  ],
  'Inspection counts changed: review the conditional likelihoods before using this demo.',
);
const inspectionLikelihoods = {
  likelihoodGivenScam: scamInspections.unresolved / scamInspections.attempted,
  likelihoodGivenLegitimate: legitimateInspections.unresolved / legitimateInspections.attempted,
};
const checkTable = { 'repository_inspection:unresolved': inspectionLikelihoods };
const unresolved = applyCheckResult(first.state, inspectionEvent, checkTable);
const repeatedInspection = applyCheckResult(unresolved.state, inspectionEvent, checkTable);
const afterInspection = recommendOrdinaryHiringAction(unresolved.state.scamProbability, {
  ...repository,
  inspection: 'unresolved',
});
assert.equal(unresolved.status, 'updated');
assert.ok(Math.abs(unresolved.state.scamProbability - 0.5) < 1e-12);
assert.equal(afterInspection.costAction, 'HOLD');
assert.equal(afterInspection.action, 'HOLD');
assert.deepEqual(afterInspection.optimalActions, ['HOLD', 'FLAG']);
assert.equal(repeatedInspection.status, 'duplicate_evidence');
assert.strictEqual(repeatedInspection.state, unresolved.state);
assert.ok(Math.abs(first.state.scamProbability - 2 / 9) < 1e-12);

// Alternative first-inspection outcome: branch from the request posterior,
// not from the unresolved branch. These are not two independent checks.
const cleanEvent = {
  ...inspectionEvent,
  agent_input: { ...inspectionEvent.agent_input, outcome: 'no_harmful_behaviour_found' },
};
const cleanLikelihoods = {
  likelihoodGivenScam: scamInspections.scopedClean / scamInspections.attempted,
  likelihoodGivenLegitimate: legitimateInspections.scopedClean / legitimateInspections.attempted,
};
const cleanTable = { 'repository_inspection:no_harmful_behaviour_found': cleanLikelihoods };
const clean = applyCheckResult(first.state, cleanEvent, cleanTable);
const repeatedClean = applyCheckResult(clean.state, cleanEvent, cleanTable);
const scopedCleanRepository: RepositoryAssessment = {
  ...repository,
  inspection: 'no_harmful_behaviour_found',
};
const beforeAuthorisation = recommendOrdinaryHiringAction(
  clean.state.scamProbability,
  scopedCleanRepository,
);
const authorisationEvent = {
  kind: 'check_result',
  agent_input: {
    check: 'assessment_authorisation',
    outcome: 'verified',
    artifact: 'exercise-repository',
  },
};
// No conditional likelihood has been configured for authorisation.
// It satisfies an execution constraint without inventing a probability update.
const authorisation = applyCheckResult(clean.state, authorisationEvent, {});
const afterAuthorisation = recommendOrdinaryHiringAction(authorisation.state.scamProbability, {
  ...scopedCleanRepository,
  assessmentAuthorisation: 'verified',
});
assert.equal(clean.status, 'updated');
assert.ok(Math.abs(clean.state.scamProbability - 1 / 21) < 1e-12);
assert.equal(repeatedClean.status, 'duplicate_evidence');
assert.strictEqual(repeatedClean.state, clean.state);
assert.equal(beforeAuthorisation.costAction, 'SAFE');
assert.equal(beforeAuthorisation.action, 'HOLD');
assert.equal(authorisation.status, 'unmodelled_evidence');
assert.strictEqual(authorisation.state, clean.state);
assert.equal(afterAuthorisation.action, 'SAFE');
assert.ok(afterAuthorisation.repositoryRecommendation?.precautions?.length);
assert.ok(Math.abs(first.state.scamProbability - 2 / 9) < 1e-12);

// Another alternative first-inspection outcome. The authored 0/21 count is
// not installed as a calibrated zero likelihood. No posterior is invented.
const harmfulEvent = {
  ...inspectionEvent,
  agent_input: { ...inspectionEvent.agent_input, outcome: 'harmful_behaviour_found' },
};
const harmful = applyCheckResult(first.state, harmfulEvent, {});
const repeatedHarmful = applyCheckResult(harmful.state, harmfulEvent, {});
const harmfulRepository: RepositoryAssessment = {
  ...repository,
  inspection: 'harmful_behaviour_found',
  assessmentAuthorisation: 'verified',
};
const afterHarmful = recommendOrdinaryHiringAction(
  harmful.state.scamProbability,
  harmfulRepository,
);
assert.equal(harmful.status, 'unmodelled_evidence');
assert.strictEqual(harmful.state, first.state);
assert.equal(repeatedHarmful.status, 'unmodelled_evidence');
assert.strictEqual(repeatedHarmful.state, harmful.state);
assert.equal(afterHarmful.costAction, 'SAFE');
assert.equal(afterHarmful.action, 'FLAG');
assert.equal(afterHarmful.safetyOverride, true);
assert.match(afterHarmful.repositoryRecommendation!.reason, /do not execute/i);
// The same confirmed behaviour also overrides a previously scoped-clean SAFE.
assert.equal(
  recommendOrdinaryHiringAction(clean.state.scamProbability, harmfulRepository).action,
  'FLAG',
);

console.log(
  JSON.stringify(
    {
      purpose: 'reviewed_synthetic_bayes_exercise',
      source,
      held_out: false,
      limitations:
        'Uses authored full-conversation counts for a worked example. These are not validated turn-conditioned likelihoods or deployment priors. No LLM extraction or live inspection runs. Missing inspection likelihoods preserve belief.',
      prior: prior.scamProbability,
      likelihoods,
      first_request: {
        status: first.status,
        posterior: first.state.scamProbability,
        cost_action: decision.costAction,
        final_action: decision.action,
      },
      repeated_request: { status: repeated.status, posterior: repeated.state.scamProbability },
      missing_likelihood_row: {
        status: unmodelled.status,
        posterior: unmodelled.state.scamProbability,
      },
      inspection_likelihoods_given_execution_request: inspectionLikelihoods,
      unresolved_inspection: {
        status: unresolved.status,
        posterior: unresolved.state.scamProbability,
        cost_action: afterInspection.costAction,
        final_action: afterInspection.action,
      },
      repeated_inspection: {
        status: repeatedInspection.status,
        posterior: repeatedInspection.state.scamProbability,
      },
      alternative_scoped_clean_branch: {
        starts_from: first.state.scamProbability,
        likelihoods: cleanLikelihoods,
        status: clean.status,
        posterior: clean.state.scamProbability,
        before_authorisation: {
          cost_action: beforeAuthorisation.costAction,
          final_action: beforeAuthorisation.action,
        },
        repeated_clean_result: {
          status: repeatedClean.status,
          posterior: repeatedClean.state.scamProbability,
        },
        after_authorisation: {
          update_status: authorisation.status,
          posterior: authorisation.state.scamProbability,
          final_action: afterAuthorisation.action,
          precautions: afterAuthorisation.repositoryRecommendation?.precautions,
        },
      },
      alternative_confirmed_harm_branch: {
        starts_from: first.state.scamProbability,
        update_status: harmful.status,
        last_modelled_probability: harmful.state.scamProbability,
        probability_note:
          'Retained pre-inspection belief: confirmed harm is not numerically modelled. Do not interpret this as a posterior incorporating the harmful finding.',
        cost_action: afterHarmful.costAction,
        final_action: afterHarmful.action,
        safety_override: afterHarmful.safetyOverride,
        reason: afterHarmful.repositoryRecommendation?.reason,
        repeated_result: {
          update_status: repeatedHarmful.status,
          last_modelled_probability: repeatedHarmful.state.scamProbability,
        },
      },
      assertions: 'passed',
    },
    null,
    2,
  ),
);
