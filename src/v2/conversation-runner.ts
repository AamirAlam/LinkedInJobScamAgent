import { z } from 'zod';
import { applyAssessmentAuthorisation } from './assessment-authorisation.ts';
import { recommendRepositoryAction } from './repository-policy.ts';
import {
  extractExecutionRequests,
  validateExecutionAnnotation,
  visibleMessages,
} from './execution-extractor.ts';
import type { ExecutionAnnotation, VisibleMessage } from './execution-extractor.ts';
import { parseRepositoryUrl } from './repository-source.ts';
import { runRepositoryInspection } from './repository-inspection-cycle.ts';

export type ConversationAuthorisation = {
  rawRecord: string;
  rawSource: string;
  sourcePath: string;
};

function decideInspectedRequest(
  inspection: Awaited<ReturnType<typeof runRepositoryInspection>>,
  artifact: string,
  requestedAction: string,
  isCurrentRequest: boolean,
  authorisation: ReturnType<typeof applyAssessmentAuthorisation> | undefined,
) {
  if (!authorisation) {
    return {
      recommendation:
        inspection.recommendation.action === 'FLAG'
          ? inspection.recommendation
          : recommendRepositoryAction({
              executionRequested: true,
              inspection: inspection.inspection.outcome,
              assessmentAuthorisation: 'unresolved',
            }),
      authorisation_status: 'not_supplied',
    };
  }
  const scope = inspection.inspection.scope;
  const binding = authorisation.binding;
  const matches =
    artifact === binding.artifact &&
    inspection.inspection.artifact === artifact &&
    requestedAction === binding.requested_action &&
    scope?.requested_action === requestedAction &&
    scope.artifact_revision === binding.revision &&
    scope.inspection_boundary === binding.inspection_boundary;
  const priorHarm = matches && authorisation.inspection.outcome === 'harmful_behaviour_found';
  const recommendation = recommendRepositoryAction({
    executionRequested: true,
    inspection:
      priorHarm || inspection.recommendation.action === 'FLAG'
        ? 'harmful_behaviour_found'
        : inspection.inspection.outcome,
    assessmentAuthorisation:
      matches && isCurrentRequest ? authorisation.assessment.assessmentAuthorisation : 'unresolved',
  });
  return {
    recommendation,
    authorisation_status: matches
      ? isCurrentRequest
        ? authorisation.assessment.assessmentAuthorisation
        : 'later_message_requires_reassessment'
      : 'scope_mismatch',
  };
}

/** Validate a conversation and strip labels before any network or model work. */
export function parseConversation(input: unknown): VisibleMessage[] {
  const parsed = z
    .object({
      messages: z
        .array(
          z.object({
            time: z.string().min(1),
            sender: z.enum(['candidate', 'counterparty', 'recruiter']),
            message: z.string().min(1),
          }),
        )
        .min(1)
        .max(100),
    })
    .parse(input);
  return visibleMessages(
    parsed.messages.map((message) => ({
      ...message,
      sender: message.sender === 'recruiter' ? 'counterparty' : message.sender,
    })),
  );
}

// One inspection per conversation run. Subsequent instructions require a new
// assessment; no earlier scoped result silently authorises them. No synthetic prior.
/** Yield decisions sequentially, holding execution before at most one read-only repository inspection. */
export async function* runConversation(
  input: unknown,
  extract: (
    messages: readonly VisibleMessage[],
  ) => Promise<ExecutionAnnotation> = extractExecutionRequests,
  inspect: typeof runRepositoryInspection = runRepositoryInspection,
  authorisationInput?: ConversationAuthorisation,
) {
  const messages = parseConversation(input); // preflight before any paid/network work
  const authorisation = authorisationInput
    ? applyAssessmentAuthorisation(
        authorisationInput.rawRecord,
        authorisationInput.rawSource,
        authorisationInput.sourcePath,
      )
    : undefined;
  let inspected = false;
  let executionSeen = false;
  let flagged = false;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const prefix = messages.slice(0, messageIndex + 1);
    const current = messages[messageIndex];
    if (flagged || inspected) {
      yield {
        time: current.time,
        action: flagged ? 'FLAG' : 'HOLD',
        scope: 'repository_execution',
        inspection_triggered: false,
        reason: flagged
          ? 'Previously identified harmful behaviour remains unresolved.'
          : 'Execution remains on hold; new instructions require reassessment. Existing inspection is not repeated.',
      };
      continue;
    }
    let annotation: ExecutionAnnotation;
    try {
      annotation = validateExecutionAnnotation(await extract(prefix), prefix);
    } catch {
      yield {
        time: current.time,
        action: 'HOLD',
        scope: 'conversation_only',
        inspection_triggered: false,
        reason: 'Execution-request extraction failed; no repository was fetched.',
      };
      continue;
    }
    if (annotation.status !== 'present') {
      yield {
        time: current.time,
        annotation,
        action: executionSeen || annotation.status === 'ambiguous' ? 'HOLD' : 'SAFE',
        scope: executionSeen ? 'repository_execution' : 'conversation_only',
        inspection_triggered: false,
        reason: executionSeen
          ? 'Earlier execution request remains unresolved.'
          : 'No explicit execution request established. SAFE permits conversation only, never code execution.',
      };
      continue;
    }
    executionSeen = true;
    const request = prefix.find(
      (message) => message.time === annotation.first_explicit_request_message,
    )!;
    // Require the URL in the execution-request message. Inferring which older
    // repository a later command refers to requires a separate binding model.
    const urls = findRepositoryTargets(request.message);
    if (urls.size !== 1) {
      yield {
        time: current.time,
        annotation,
        action: 'HOLD',
        scope: 'repository_execution',
        inspection_triggered: false,
        reason:
          'Execution request must identify exactly one supported repository root URL; clarify the target.',
      };
      continue;
    }
    const artifact = [...urls][0];
    // Surface HOLD before slow source/API work. No unverified execution window.
    yield {
      time: current.time,
      annotation,
      artifact,
      action: 'HOLD',
      scope: 'repository_execution',
      inspection_triggered: true,
      reason: 'Execution request detected; inspecting source without executing it.',
    };
    inspected = true;
    try {
      const inspection = await inspect(artifact, request.message);
      const decision = decideInspectedRequest(
        inspection,
        artifact,
        request.message,
        request.time === current.time,
        authorisation,
      );
      flagged = decision.recommendation.action === 'FLAG';
      yield {
        time: current.time,
        artifact,
        action: decision.recommendation.action ?? 'HOLD',
        scope: 'repository_execution',
        inspection_triggered: false,
        inspection,
        authorisation_status: decision.authorisation_status,
        ...(authorisationInput
          ? { authorisation_record_sha256: authorisation?.submitted_record_sha256 }
          : {}),
        reason: decision.recommendation.reason,
        ...('precautions' in decision.recommendation
          ? { precautions: decision.recommendation.precautions }
          : {}),
      };
    } catch {
      yield {
        time: current.time,
        artifact,
        action: 'HOLD',
        scope: 'repository_execution',
        inspection_triggered: false,
        reason: 'Inspection failed; execution remains on hold.',
      };
    }
  }
}

function findRepositoryTargets(message: string): ReadonlySet<string> {
  const targets = (message.match(/https?:\/\/[^\s<>"'`]+/g) ?? []).flatMap((url) => {
    try {
      return [parseRepositoryUrl(url.replace(/[.,;)]*$/, '')).artifact];
    } catch {
      return [];
    } // Unsupported targets cannot trigger source inspection.
  });
  return new Set(targets);
}
