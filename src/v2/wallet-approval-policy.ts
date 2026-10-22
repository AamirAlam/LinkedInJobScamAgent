import { z } from 'zod';
import { visibleMessages } from './execution-extractor.ts';
import type { VisibleMessage } from './execution-extractor.ts';
import type { Action } from './decision-cost.ts';

const requestSchema = z.object({
  artifact: z.string().url(),
  message_id: z.string().trim().min(1),
  quote: z.string().trim().min(1),
});
const checkSchema = z.object({
  check: z.literal('wallet_approval_inspection'),
  artifact: z.string().url(),
  requested_after_event: z.string().trim().min(1),
  outcome: z.enum(['unresolved', 'no_harmful_behaviour_found', 'harmful_behaviour_found']),
  finding: z.string().trim().min(1),
});
export type WalletApprovalState = {
  readonly request: z.infer<typeof requestSchema> | null;
  readonly inspection:
    'pending' | 'unresolved' | 'no_harmful_behaviour_found' | 'harmful_behaviour_found';
  readonly harmfulObserved: boolean;
};
export const initialWalletApprovalState: WalletApprovalState = {
  request: null,
  inspection: 'pending',
  harmfulObserved: false,
};

/** Record a caller-annotated current wallet request; validates provenance, not semantic classification. */
export function recordWalletApprovalRequest(
  state: WalletApprovalState,
  rawRequest: unknown,
  messages: readonly VisibleMessage[],
): WalletApprovalState {
  const request = requestSchema.parse(rawRequest);
  const prefix = visibleMessages(messages);
  const current = prefix.at(-1)!;
  if (
    current.time !== request.message_id ||
    current.sender !== 'counterparty' ||
    !current.message.includes(request.quote) ||
    !prefix.some(
      (message) => message.sender === 'counterparty' && message.message.includes(request.artifact),
    )
  ) {
    throw new Error(
      'Wallet request must cite the current counterparty message and an already visible artifact.',
    );
  }
  if (state.request?.message_id === request.message_id) {
    if (state.request.artifact !== request.artifact || state.request.quote !== request.quote) {
      throw new Error('A wallet request identifier cannot change its scope.');
    }
    return state;
  }
  return { ...state, request, inspection: 'pending' };
}

/** Consume a caller-supplied inspection outcome for this request; does not inspect or interact with wallets. */
export function recordWalletApprovalInspection(
  state: WalletApprovalState,
  rawCheck: unknown,
): WalletApprovalState {
  const check = checkSchema.parse(rawCheck);
  if (
    !state.request ||
    check.artifact !== state.request.artifact ||
    check.requested_after_event !== state.request.message_id
  ) {
    throw new Error(
      'Wallet inspection requires the same artifact and an already recorded wallet request.',
    );
  }
  return {
    ...state,
    inspection: check.outcome,
    harmfulObserved: state.harmfulObserved || check.outcome === 'harmful_behaviour_found',
  };
}

type Recommendation = { readonly action: Action | null; readonly reason: string };
/** Preserve prior harm and hold new wallet permissions; repository authorisation cannot release spending. */
export function applyWalletApprovalGate(
  state: WalletApprovalState,
  repositoryDecision: Recommendation,
): Recommendation {
  if (state.harmfulObserved || repositoryDecision.action === 'FLAG') {
    return {
      ...repositoryDecision,
      action: 'FLAG',
      reason:
        'Previously identified or reported harmful behaviour remains unresolved; do not grant wallet permissions.',
    };
  }
  if (!state.request) {
    return repositoryDecision;
  }
  return {
    ...repositoryDecision,
    action: 'HOLD',
    reason:
      state.inspection === 'no_harmful_behaviour_found'
        ? 'Wallet source review does not grant action-specific permission to spend funds; do not sign or submit the approval.'
        : 'Wallet permission request requires its own assessment; do not sign or submit the approval.',
  };
}
