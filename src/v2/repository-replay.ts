import { z } from 'zod';
import {
  extractExecutionRequests,
  validateExecutionAnnotation,
  visibleMessages,
} from './execution-extractor.ts';
import type { ExecutionAnnotation, VisibleMessage } from './execution-extractor.ts';
import { recommendRepositoryAction } from './repository-policy.ts';
import type { RepositoryAssessment } from './repository-policy.ts';
import { applyCheckResult, applyEvidence, isValidProbability } from './bayes.ts';
import type { BeliefState, Likelihoods } from './bayes.ts';
import { recommendOrdinaryHiringAction } from './decision-policy.ts';

export type ReplayBeliefConfig = {
  priorScam: number;
  executionLikelihoods: Likelihoods;
  // Keys are repository_inspection:OUTCOME. Conditional on execution already
  // requested; applies only to FIRST inspection, never a follow-up.
  firstInspectionLikelihoods: Readonly<Partial<Record<string, Likelihoods>>>;
};

// Static-inspection records only: this schema does not inspect or execute files,
// or establish that a supplied finding is true.
const inspectionScopeSchema = z
  .object({
    requested_action: z.string().trim().min(1),
    artifact_revision: z.string().trim().min(1),
    inspected_files: z.array(z.string().trim().min(1)),
    findings: z.array(
      z.object({
        file: z.string().trim().min(1),
        start_line: z.number().int().positive(),
        end_line: z.number().int().positive(),
        behaviour: z.string().trim().min(1),
        harmful: z.boolean(),
      }),
    ),
    // Relevant missing files, uninspected dependencies, or exhausted budget.
    gaps: z.array(z.string().trim().min(1)),
  })
  .superRefine((scope, context) => {
    for (const finding of scope.findings) {
      if (!scope.inspected_files.includes(finding.file) || finding.end_line < finding.start_line) {
        context.addIssue({
          code: 'custom',
          message: 'Findings require an inspected file and a valid line range.',
        });
      }
    }
  });

const repositoryInspectionSchema = z
  .object({
    check: z.literal('repository_inspection'),
    artifact: z.string(),
    outcome: z.enum(['unresolved', 'no_harmful_behaviour_found', 'harmful_behaviour_found']),
    finding: z.string().min(1),
    limitations: z.string().optional(),
    // Optional only for compatibility with existing scripted development fixtures.
    scope: inspectionScopeSchema.optional(),
  })
  .superRefine((input, context) => {
    const scope = input.scope;
    if (!scope) {
      return;
    }
    const harmful = scope.findings.some((finding) => finding.harmful);
    if ((input.outcome === 'harmful_behaviour_found') !== harmful) {
      context.addIssue({
        code: 'custom',
        message: 'Harmful outcome must match cited harmful findings.',
      });
    }
    if (
      input.outcome === 'no_harmful_behaviour_found' &&
      (scope.gaps.length > 0 || scope.inspected_files.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A scoped clean assessment requires inspected files and no unresolved execution-path gaps.',
      });
    }
  });

export const repositoryEventSchema = z.discriminatedUnion('kind', [
  z.object({
    event_id: z.string().min(1),
    kind: z.literal('message'),
    agent_input: z.object({ sender: z.enum(['candidate', 'counterparty']), message: z.string() }),
  }),
  z.object({
    event_id: z.string().min(1),
    kind: z.literal('check_result'),
    check_id: z.string(),
    requested_after_event: z.string(),
    agent_input: z.discriminatedUnion('check', [
      repositoryInspectionSchema,
      z.object({
        check: z.literal('assessment_authorisation'),
        artifact: z.string(),
        outcome: z.enum(['unresolved', 'verified']),
        finding: z.string().min(1),
      }),
    ]),
  }),
]);

export type RepositoryReplayStep = {
  event_id: string;
  annotation: ExecutionAnnotation | null;
  assessment: RepositoryAssessment;
  inspectionScope?: z.infer<typeof inspectionScopeSchema>;
  recommendation: ReturnType<typeof recommendRepositoryAction> & {
    scope: 'conversation_only' | 'repository_execution';
    guidance: string;
  };
  probabilistic?: {
    belief: BeliefState;
    updateStatus: string;
    probabilityMeaning: 'configured_prior' | 'posterior_over_modelled_evidence';
    lastUpdatedAtEvent: string | null;
    unmodelledEvidenceEventIds: readonly string[];
    decision: ReturnType<typeof recommendOrdinaryHiringAction>;
  };
};

function describeActionScope(action: string | null, assessment: RepositoryAssessment) {
  const scope =
    assessment.executionRequested || assessment.inspection === 'harmful_behaviour_found'
      ? ('repository_execution' as const)
      : ('conversation_only' as const);
  const guidance =
    action === null
      ? 'No repository-execution recommendation; assess new requests before acting.'
      : action === 'FLAG'
        ? 'Reject the flagged recruitment request; do not execute any requested repository.'
        : action === 'HOLD'
          ? scope === 'repository_execution'
            ? 'Do not execute the repository; keep the assessment on hold.'
            : 'Pause the conversation and seek verification before proceeding.'
          : scope === 'repository_execution'
            ? 'Proceed only with the inspected assessment and stated precautions; reassess new requests.'
            : 'Continue the conversation only; repository execution has not been authorised.';
  return { scope, guidance };
}

type RepositoryEvent = z.infer<typeof repositoryEventSchema>;
type CheckResultEvent = Extract<RepositoryEvent, { kind: 'check_result' }>;

function updateInspectionBelief(
  belief: BeliefState,
  event: CheckResultEvent,
  config: ReplayBeliefConfig,
  inspectionSeen: boolean,
) {
  // Follow-ups depend on earlier findings; reusing first-check likelihoods double-counts evidence.
  if (inspectionSeen) {
    return { state: belief, status: 'unmodelled_followup_inspection' };
  }
  if (!belief.appliedEvidenceIds.includes('conversation:execution-request')) {
    return { state: belief, status: 'unmodelled_inspection_without_execution_evidence' };
  }
  return applyCheckResult(belief, event, config.firstInspectionLikelihoods);
}

function validateCheckReference(
  event: CheckResultEvent,
  assessmentArtifact: string,
  seenEvents: ReadonlySet<string>,
  messages: readonly VisibleMessage[],
): void {
  const input = event.agent_input;
  if (event.check_id !== input.check || !seenEvents.has(event.requested_after_event)) {
    throw new Error('Check result must reference an earlier event and the matching check.');
  }
  const artifactVisible = messages.some(
    (message) =>
      message.sender === 'counterparty' &&
      (message.message.match(/https?:\/\/[^\s<>"']+/g) ?? []).some(
        (url) => url.replace(/[.,;)]*$/, '') === assessmentArtifact,
      ),
  );
  if (input.artifact !== assessmentArtifact || !artifactVisible) {
    throw new Error('Check result must concern the repository visible in this assessment.');
  }
}

// One known repository assessment; checks are supplied by the caller, not performed here.
// No ground truth, expected actions, or previous model outputs enter extraction.
/** Replay arrived evidence in order without exposing labels or double-counting repeated checks. */
export async function* replayRepositoryEvents(
  events: readonly unknown[],
  assessmentArtifact: string,
  extract: (
    messages: readonly VisibleMessage[],
  ) => Promise<ExecutionAnnotation> = extractExecutionRequests,
  beliefConfig?: ReplayBeliefConfig,
): AsyncGenerator<RepositoryReplayStep> {
  if (!assessmentArtifact.trim()) {
    throw new Error('Assessment artifact is required.');
  }
  if (beliefConfig && !isValidProbability(beliefConfig.priorScam)) {
    throw new RangeError('Configured prior must be a finite probability.');
  }
  let belief: BeliefState | undefined = beliefConfig
    ? { scamProbability: beliefConfig.priorScam, appliedEvidenceIds: [] }
    : undefined;
  let inspectionSeen = false;
  let inspectionScope: z.infer<typeof inspectionScopeSchema> | undefined;
  let lastUpdatedAtEvent: string | null = null;
  let unmodelledEvidenceEventIds: readonly string[] = [];
  let assessment: RepositoryAssessment = {
    executionRequested: false,
    inspection: 'pending',
    assessmentAuthorisation: 'unresolved',
  };
  let messages: VisibleMessage[] = [];
  let seenEvents = new Set<string>();
  for (const rawEvent of events) {
    const event = repositoryEventSchema.parse(rawEvent); // strips reviewer metadata
    if (seenEvents.has(event.event_id)) {
      throw new Error('Duplicate event ID.');
    }
    let annotation: ExecutionAnnotation | null = null;
    let updateStatus = 'no_new_evidence';
    if (event.kind === 'message') {
      messages = [...messages, { time: event.event_id, ...event.agent_input }];
      const prefix = visibleMessages(messages);
      annotation = validateExecutionAnnotation(await extract(prefix), prefix);
      if (belief && beliefConfig && annotation.status === 'present') {
        const result = applyEvidence(
          belief,
          'conversation:execution-request',
          beliefConfig.executionLikelihoods,
        );
        belief = result.state;
        updateStatus = result.status;
      }
      assessment = {
        ...assessment,
        executionRequested: assessment.executionRequested || annotation.status === 'present',
      };
    } else {
      const input = event.agent_input;
      validateCheckReference(event, assessmentArtifact, seenEvents, messages);
      if (input.check === 'repository_inspection') {
        inspectionScope = input.scope;
        if (belief && beliefConfig) {
          const result = updateInspectionBelief(belief, event, beliefConfig, inspectionSeen);
          belief = result.state;
          updateStatus = result.status;
        }
        inspectionSeen = true;
        // Known harmful behaviour is not erased by a later incomplete clean check.
        if (assessment.inspection !== 'harmful_behaviour_found') {
          assessment = { ...assessment, inspection: input.outcome };
        }
      } else {
        if (belief) {
          updateStatus = 'unmodelled_evidence';
        } // no authorisation likelihood configured
        assessment = { ...assessment, assessmentAuthorisation: input.outcome };
      }
    }
    seenEvents = new Set([...seenEvents, event.event_id]);
    if (belief) {
      if (updateStatus === 'updated') {
        lastUpdatedAtEvent = event.event_id;
      }
      if (updateStatus.startsWith('unmodelled_') || updateStatus === 'unsupported_evidence') {
        unmodelledEvidenceEventIds = [...unmodelledEvidenceEventIds, event.event_id];
      }
    }
    yield buildReplayStep(
      event.event_id,
      annotation,
      assessment,
      inspectionScope,
      belief ? { belief, updateStatus, lastUpdatedAtEvent, unmodelledEvidenceEventIds } : undefined,
    );
  }
}

function buildReplayStep(
  eventId: string,
  annotation: ExecutionAnnotation | null,
  assessment: RepositoryAssessment,
  inspectionScope: RepositoryReplayStep['inspectionScope'],
  probability?: Pick<
    NonNullable<RepositoryReplayStep['probabilistic']>,
    'belief' | 'updateStatus' | 'lastUpdatedAtEvent' | 'unmodelledEvidenceEventIds'
  >,
): RepositoryReplayStep {
  const repositoryRecommendation = recommendRepositoryAction(assessment);
  if (!probability) {
    return {
      event_id: eventId,
      annotation,
      assessment,
      inspectionScope,
      recommendation: {
        ...repositoryRecommendation,
        ...describeActionScope(repositoryRecommendation.action, assessment),
      },
    };
  }
  const { belief, updateStatus, lastUpdatedAtEvent, unmodelledEvidenceEventIds } = probability;
  const decision = recommendOrdinaryHiringAction(belief.scamProbability, assessment);
  return {
    event_id: eventId,
    annotation,
    assessment,
    inspectionScope,
    recommendation: {
      action: decision.action,
      ...describeActionScope(decision.action, assessment),
      reason:
        decision.action === repositoryRecommendation.action
          ? repositoryRecommendation.reason
          : 'Lowest expected-cost action under the configured belief and ordinary-hiring cost assumptions.',
      ...(decision.action === 'SAFE' && repositoryRecommendation.precautions
        ? { precautions: repositoryRecommendation.precautions }
        : {}),
    },
    probabilistic: {
      belief,
      updateStatus,
      decision,
      probabilityMeaning:
        lastUpdatedAtEvent === null ? 'configured_prior' : 'posterior_over_modelled_evidence',
      lastUpdatedAtEvent,
      unmodelledEvidenceEventIds,
    },
  };
}
