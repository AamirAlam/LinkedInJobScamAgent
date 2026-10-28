import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runConversation } from '../conversation-runner.ts';
import {
  createConversationBeliefTracker,
  parseConversationBeliefConfig,
} from '../conversation-belief.ts';
import { calculateBinaryEntropy } from '../bayes.ts';
import type { ExecutionAnnotation, VisibleMessage } from '../execution-extractor.ts';
import { runRepositoryInspection } from '../repository-inspection-cycle.ts';
import { collectSteps, noWalletRequests } from './fixtures.ts';

// Reviewed synthetic development proportions, not measured scam probabilities.
const config = parseConversationBeliefConfig(
  JSON.parse(
    readFileSync(resolve(__dirname, '../config/repository-belief.synthetic.json'), 'utf8'),
  ),
);
const artifact = 'https://github.com/example/demo';
const request = `Run npm start in ${artifact}`;
const extract = async (messages: readonly VisibleMessage[]): Promise<ExecutionAnnotation> => {
  const evidence = messages.find(
    (message) => message.sender === 'counterparty' && message.message === request,
  );
  return evidence
    ? {
        status: 'present',
        first_explicit_request_message: evidence.time,
        supporting_message: evidence.time,
        quote: evidence.message,
        reason: 'Explicit request in the arrived prefix.',
      }
    : {
        status: 'absent_so_far',
        first_explicit_request_message: null,
        supporting_message: null,
        quote: null,
        reason: 'No execution request.',
      };
};
const missingInspection: typeof runRepositoryInspection = (url, action) =>
  runRepositoryInspection(url, action, {
    fetcher: (async () => new Response('', { status: 404 })) as typeof fetch,
  });
const observation = {
  time: 't0',
  action: 'SAFE',
  scope: 'conversation_only',
  reason: 'Conversation only.',
  inspection_triggered: false,
};

test('live conversation applies execution then conditional inspection likelihoods while preserving authorisation HOLD', async () => {
  let inspections = 0;
  let executionCalls = 0;
  const steps = await collectSteps(
    runConversation(
      {
        messages: [
          { time: 't0', sender: 'recruiter', message: request },
          { time: 't1', sender: 'candidate', message: 'I will wait.' },
          { time: 't2', sender: 'recruiter', message: request },
        ],
      },
      async (messages) => {
        executionCalls += 1;
        return extract(messages);
      },
      async (url, action) => {
        inspections += 1;
        const result = await missingInspection(url, action);
        return {
          ...result,
          inspection: { ...result.inspection, outcome: 'no_harmful_behaviour_found' as const },
          recommendation: { action: 'HOLD', reason: 'Authorisation unresolved.' },
        };
      },
      undefined,
      noWalletRequests,
      config,
    ),
  );
  const first = steps[0].probabilistic!;
  const inspected = steps[1].probabilistic!;
  assert.ok(Math.abs(first.distribution.scam - 2 / 9) < 1e-12);
  assert.ok(Math.abs(inspected.distribution.scam - 1 / 21) < 1e-12);
  assert.equal(inspected.distribution.legitimate, 1 - inspected.distribution.scam);
  assert.equal(inspected.entropyBits, calculateBinaryEntropy(1 / 21));
  assert.equal(inspected.lastUpdatedAtEvent, 't0:repository_inspection');
  assert.equal(inspected.decision.costAction, 'SAFE');
  assert.equal(inspected.decision.action, 'HOLD');
  assert.equal(inspected.decision.safetyOverride, true);
  assert.equal(steps[1].action, 'HOLD');
  assert.equal(inspected.belief.appliedEvidenceIds.length, 2);
  assert.deepEqual(steps[2].probabilistic?.belief, inspected.belief);
  assert.deepEqual(steps[3].probabilistic?.belief, inspected.belief);
  assert.equal(steps[2].probabilistic?.updateStatus, 'candidate_context_only');
  assert.equal(inspections, 1);
  assert.equal(executionCalls, 1);
});

test('unmodelled harmful findings retain FLAG and disclose that the number excludes that evidence', async () => {
  const steps = await collectSteps(
    runConversation(
      { messages: [{ time: 't0', sender: 'recruiter', message: request }] },
      extract,
      async (url, action) => {
        const result = await missingInspection(url, action);
        return {
          ...result,
          inspection: { ...result.inspection, outcome: 'harmful_behaviour_found' as const },
          recommendation: {
            action: 'FLAG',
            reason: 'Injected harmful finding for a local regression, not a real inspection.',
          },
        };
      },
      undefined,
      noWalletRequests,
      config,
    ),
  );
  const final = steps.at(-1)!;
  assert.equal(final.action, 'FLAG');
  assert.ok(Math.abs(final.probabilistic!.distribution.scam - 2 / 9) < 1e-12);
  assert.equal(final.probabilistic?.updateStatus, 'unmodelled_evidence');
  assert.deepEqual(final.probabilistic?.unmodelledEvidenceEventIds, ['t0:repository_inspection']);
  assert.equal(final.probabilistic?.lastUpdatedAtEvent, 't0:execution_request');
  assert.equal(final.probabilistic?.decision.costAction, 'SAFE');
  assert.equal(final.probabilistic?.decision.safetyOverride, true);
});

test('candidate-only input makes no calls, and an omitted configuration preserves the existing output shape', async () => {
  const messages = [{ time: 't0', sender: 'candidate', message: request }];
  const rejectCall = async (): Promise<never> =>
    assert.fail('Candidate reply triggered external work');
  const ordinary = await collectSteps(
    runConversation({ messages }, rejectCall, rejectCall, undefined, rejectCall),
  );
  assert.equal('probabilistic' in ordinary[0], false);
  const configured = await collectSteps(
    runConversation({ messages }, rejectCall, rejectCall, undefined, rejectCall, config),
  );
  assert.equal(configured[0].probabilistic?.distribution.scam, config.priorScam);
  assert.equal(configured[0].probabilistic?.updateStatus, 'candidate_context_only');
  assert.deepEqual(configured[0].probabilistic?.belief.appliedEvidenceIds, []);
});

test('strict preflight rejects invalid probability models before external work', async () => {
  const rejectCall = async (): Promise<never> =>
    assert.fail('Invalid config triggered external work');
  await assert.rejects(
    collectSteps(
      runConversation(
        { messages: [{ time: 't0', sender: 'recruiter', message: request }] },
        rejectCall,
        rejectCall,
        undefined,
        rejectCall,
        { ...config, priorScam: 2 },
      ),
    ),
  );
  assert.throws(() => parseConversationBeliefConfig({ ...config, provenance: undefined }));
  assert.throws(() =>
    parseConversationBeliefConfig({
      ...config,
      firstInspectionLikelihoods: {
        'repository_inspection:unresolved': config.executionLikelihoods,
        'repository_inspection:no_harmful_behaviour_found': config.executionLikelihoods,
      },
    }),
  );
  assert.throws(() =>
    parseConversationBeliefConfig({
      ...config,
      firstInspectionLikelihoods: {
        'repository_inspection:unresolved': config.executionLikelihoods,
        'repository_inspection:no_harmful_behaviour_found': config.executionLikelihoods,
        'repository_inspection:harmful_behaviour_found': config.executionLikelihoods,
      },
    }),
  );
});

test('duplicate and unsupported evidence cannot manufacture a new posterior', () => {
  const track = createConversationBeliefTracker(config);
  const first = track({ ...observation, annotation: { status: 'present' } });
  const repeated = track({ ...observation, time: 't1', annotation: { status: 'present' } });
  assert.equal(repeated.probabilistic.updateStatus, 'duplicate_evidence');
  assert.deepEqual(repeated.probabilistic.belief, first.probabilistic.belief);
  const unsupported = createConversationBeliefTracker({
    ...config,
    executionLikelihoods: { likelihoodGivenScam: 0, likelihoodGivenLegitimate: 0 },
  })({ ...observation, action: 'HOLD', annotation: { status: 'present' } });
  assert.equal(unsupported.probabilistic.updateStatus, 'unsupported_evidence');
  assert.equal(unsupported.probabilistic.distribution.scam, config.priorScam);
  assert.deepEqual(unsupported.probabilistic.unmodelledEvidenceEventIds, ['t0:execution_request']);
  assert.equal(unsupported.action, 'HOLD');
});

test('cost choices operate on configured beliefs while hard wallet and inspection boundaries remain', () => {
  // Prior one is an arithmetic boundary fixture, not an estimate about recruitment.
  const track = createConversationBeliefTracker({ ...config, priorScam: 1 });
  assert.equal(track(observation).action, 'FLAG');
  assert.equal(track({ ...observation, time: 't1', candidate_recorded: true }).action, 'FLAG');
  assert.equal(
    track({ ...observation, action: 'HOLD', inspection_triggered: true }).action,
    'HOLD',
  );
  const wallet = track({
    ...observation,
    action: 'HOLD',
    scope: 'wallet_approval',
    wallet_annotation: { status: 'present' },
  });
  assert.equal(wallet.action, 'HOLD');
  assert.equal(wallet.probabilistic.distribution.scam, 1);
  assert.equal(wallet.probabilistic.updateStatus, 'unmodelled_evidence');
  assert.equal(wallet.probabilistic.decision.constraint, 'wallet_permission_boundary');
  const candidateFirst = createConversationBeliefTracker({ ...config, priorScam: 1 })({
    ...observation,
    candidate_recorded: true,
  });
  assert.equal(candidateFirst.action, 'SAFE');
  assert.equal(candidateFirst.probabilistic.decision.constraint, 'candidate_context_only');
});

test('binary entropy handles certainty, equal beliefs and invalid numbers', () => {
  assert.equal(calculateBinaryEntropy(0), 0);
  assert.equal(calculateBinaryEntropy(1), 0);
  assert.equal(calculateBinaryEntropy(0.5), 1);
  assert.throws(() => calculateBinaryEntropy(NaN), RangeError);
});
