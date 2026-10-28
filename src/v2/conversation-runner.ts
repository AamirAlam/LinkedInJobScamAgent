import { z } from 'zod';
import {
  extractWalletRequests,
  validateWalletRequestAnnotation,
} from './wallet-request-extractor.ts';
import {
  initialWalletApprovalState,
  recordWalletApprovalRequest,
  applyWalletApprovalGate,
} from './wallet-approval-policy.ts';
import type { WalletRequestAnnotation } from './wallet-request-extractor.ts';
import type { WalletApprovalState } from './wallet-approval-policy.ts';
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
import { createConversationBeliefTracker } from './conversation-belief.ts';

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

async function assessWalletMessage(
  messages: readonly VisibleMessage[],
  state: WalletApprovalState,
  knownArtifact: string | undefined,
  extractWallet: typeof extractWalletRequests,
) {
  try {
    const annotation = validateWalletRequestAnnotation(await extractWallet(messages), messages);
    if (annotation.status === 'absent_so_far') {
      return { state, annotation, detected: false, failed: false };
    }
    const current = messages.at(-1)!;
    if (annotation.status === 'ambiguous' || annotation.message_id !== current.time) {
      return { state, annotation, detected: true, failed: false };
    }
    const urls = [
      ...new Set(
        (current.message.match(/https?:\/\/[^\s<>"'`]+/g) ?? []).map((url) =>
          url.replace(/[.,;)]*$/, ''),
        ),
      ),
    ];
    const artifact = urls.length === 1 ? urls[0] : urls.length === 0 ? knownArtifact : undefined;
    if (!artifact) {
      return { state, annotation, detected: true, failed: false };
    }
    return {
      state: recordWalletApprovalRequest(
        state,
        { artifact, message_id: current.time, quote: annotation.quote },
        messages,
      ),
      annotation,
      detected: true,
      failed: false,
    };
  } catch {
    return { state, annotation: null, detected: false, failed: true };
  }
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
async function* runSafetyConversation(
  input: unknown,
  extract: (
    messages: readonly VisibleMessage[],
  ) => Promise<ExecutionAnnotation> = extractExecutionRequests,
  inspect: typeof runRepositoryInspection = runRepositoryInspection,
  authorisationInput?: ConversationAuthorisation,
  extractWallet: typeof extractWalletRequests = extractWalletRequests,
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
  let knownArtifact: string | undefined;
  let walletState = initialWalletApprovalState;
  let walletPending = false;
  let conversationUnresolved = false;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const prefix = messages.slice(0, messageIndex + 1);
    const current = messages[messageIndex];
    let walletAnnotation: WalletRequestAnnotation | null = null;
    if (!flagged && current.sender === 'counterparty') {
      const wallet = await assessWalletMessage(prefix, walletState, knownArtifact, extractWallet);
      walletAnnotation = wallet.annotation;
      walletState = wallet.state;
      walletPending = walletPending || wallet.detected;
      if (walletPending || wallet.failed) {
        conversationUnresolved = true;
        const decision = applyWalletApprovalGate(walletState, {
          action: 'HOLD',
          reason: 'Wallet action remains unverified.',
        });
        yield {
          time: current.time,
          wallet_annotation: walletAnnotation,
          action: decision.action ?? 'HOLD',
          scope: 'wallet_approval',
          inspection_triggered: false,
          wallet_request: walletState.request,
          reason: wallet.failed
            ? 'Wallet request extraction failed; no wallet action is authorised.'
            : walletState.request
              ? decision.reason
              : 'Wallet action or target is unresolved; do not connect, sign or grant permissions.',
        };
        continue;
      }
    }
    if (!flagged && walletPending) {
      yield {
        time: current.time,
        ...(current.sender === 'candidate' ? { candidate_recorded: true } : {}),
        wallet_annotation: walletAnnotation,
        action: 'HOLD',
        scope: 'wallet_approval',
        inspection_triggered: false,
        reason:
          'Earlier wallet request remains unresolved; do not connect, sign or grant permissions.',
      };
      continue;
    }
    if (flagged || inspected) {
      yield {
        time: current.time,
        ...(current.sender === 'candidate' ? { candidate_recorded: true } : {}),
        wallet_annotation: walletAnnotation,
        action: flagged ? 'FLAG' : 'HOLD',
        scope: 'repository_execution',
        inspection_triggered: false,
        reason: flagged
          ? 'Previously identified harmful behaviour remains unresolved.'
          : 'Execution remains on hold; new instructions require reassessment. Existing inspection is not repeated.',
      };
      continue;
    }
    // Candidate replies add context; only counterparty messages trigger analysis.
    if (current.sender === 'candidate') {
      yield {
        time: current.time,
        wallet_annotation: null,
        action: executionSeen || conversationUnresolved ? 'HOLD' : 'SAFE',
        scope: executionSeen ? 'repository_execution' : 'conversation_only',
        inspection_triggered: false,
        candidate_recorded: true,
        reason:
          'Candidate reply recorded as context only; no model call or inspection was triggered. Earlier unresolved requests remain on hold.',
      };
      continue;
    }
    let annotation: ExecutionAnnotation;
    try {
      annotation = validateExecutionAnnotation(await extract(prefix), prefix);
      conversationUnresolved = annotation.status === 'ambiguous';
    } catch {
      conversationUnresolved = true;
      yield {
        time: current.time,
        wallet_annotation: walletAnnotation,
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
        wallet_annotation: walletAnnotation,
        annotation,
        action: executionSeen || annotation.status === 'ambiguous' ? 'HOLD' : 'SAFE',
        scope: executionSeen ? 'repository_execution' : 'conversation_only',
        inspection_triggered: false,
        reason: executionSeen
          ? 'Earlier execution request remains unresolved.'
          : 'No explicit execution request established. SAFE permits conversation only, never code execution or wallet permissions.',
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
        wallet_annotation: walletAnnotation,
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
    knownArtifact = artifact;
    // Surface HOLD before slow source/API work. No unverified execution window.
    yield {
      time: current.time,
      wallet_annotation: walletAnnotation,
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
        wallet_annotation: walletAnnotation,
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
        wallet_annotation: walletAnnotation,
        artifact,
        action: 'HOLD',
        scope: 'repository_execution',
        inspection_triggered: false,
        reason: 'Inspection failed; execution remains on hold.',
      };
    }
  }
}

type SafetyStep = Exclude<
  Awaited<ReturnType<ReturnType<typeof runSafetyConversation>['next']>>['value'],
  void
>;
export type ConversationStep = SafetyStep & {
  readonly probabilistic?: ReturnType<
    ReturnType<typeof createConversationBeliefTracker>
  >['probabilistic'];
};

/** Run live safety checks, optionally applying an explicit, provenance-labelled Bayes/cost model. */
export async function* runConversation(
  input: unknown,
  extract?: Parameters<typeof runSafetyConversation>[1],
  inspect?: typeof runRepositoryInspection,
  authorisationInput?: ConversationAuthorisation,
  extractWallet?: typeof extractWalletRequests,
  beliefConfigInput?: unknown,
): AsyncGenerator<ConversationStep> {
  // Invalid model configuration must fail before model or source calls.
  const track =
    beliefConfigInput === undefined
      ? undefined
      : createConversationBeliefTracker(beliefConfigInput);
  for await (const step of runSafetyConversation(
    input,
    extract,
    inspect,
    authorisationInput,
    extractWallet,
  )) {
    yield track ? track(step) : step;
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
