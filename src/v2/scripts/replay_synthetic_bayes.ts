import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyCheckResult, applyEvidence } from '../bayes.ts';
import { recommendOrdinaryHiringAction } from '../decision-policy.ts';
import type { BeliefState } from '../bayes.ts';
import type { RepositoryAssessment } from '../repository-policy.ts';

// In-sample arithmetic demonstration, not a fitted model or held-out evaluation.
// Hidden labels are read ONLY here to reproduce the student's reviewed counts.
const source = 'data/synthesis/synthetic-benchmark-100.json';
const benchmark = JSON.parse(readFileSync(source, 'utf8'));
type Target = { ground_truth: string; execution_request_status: string };
const targets: Target[] = benchmark.cases.map((item: { evaluator_only: Target }) => item.evaluator_only);
const scams = targets.filter(item => item.ground_truth === 'scam');
const legitimate = targets.filter(item => item.ground_truth === 'legitimate');
const executionCount = (group: Target[]) => group.filter(item => item.execution_request_status === 'present').length;
assert.deepEqual([scams.length, legitimate.length, executionCount(scams), executionCount(legitimate)],
    [11, 84, 6, 21], 'Benchmark changed: review the exercise counts before using this demo.');

const prior: BeliefState = { scamProbability: scams.length / (scams.length + legitimate.length), appliedEvidenceIds: [] };
const likelihoods = {
    likelihoodGivenScam: executionCount(scams) / scams.length,
    likelihoodGivenLegitimate: executionCount(legitimate) / legitimate.length,
};
const repository: RepositoryAssessment = {
    executionRequested: true, inspection: 'pending', assessmentAuthorisation: 'unresolved',
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
const unresolved = applyCheckResult(first.state, {
    kind: 'check_result', agent_input: {
        check: 'repository_inspection', outcome: 'unresolved', artifact: 'exercise-repository',
    },
}, {});
assert.equal(unresolved.status, 'unmodelled_evidence');
assert.strictEqual(unresolved.state, first.state);

console.log(JSON.stringify({
    purpose: 'reviewed_synthetic_bayes_exercise', source, held_out: false,
    limitations: 'Uses authored full-conversation counts for a worked example. These are not validated turn-conditioned likelihoods or deployment priors. No LLM extraction or live inspection runs. Missing inspection likelihoods preserve belief.',
    prior: prior.scamProbability,
    likelihoods,
    first_request: { status: first.status, posterior: first.state.scamProbability,
        cost_action: decision.costAction, final_action: decision.action },
    repeated_request: { status: repeated.status, posterior: repeated.state.scamProbability },
    unresolved_inspection: { status: unresolved.status, posterior: unresolved.state.scamProbability },
    assertions: 'passed',
}, null, 2));
