import { z } from 'zod';
import { parseConversation, runConversation } from '../conversation-runner.ts';
import { extractExecutionRequests } from '../execution-extractor.ts';
import type { VisibleMessage } from '../execution-extractor.ts';
import { extractWalletRequests } from '../wallet-request-extractor.ts';
import { runRepositoryInspection } from '../repository-inspection-cycle.ts';

const messageSchema = z.object({
  sender: z.enum(['recruiter', 'candidate']),
  message: z.string().trim().min(1).max(8000),
});

// Exact argument snapshots let the existing runner reconstruct state without repeating
// old API calls. Cache failures too: a later message must not silently rewrite history.
function cacheCalls<Args extends readonly unknown[], Result>(
  call: (...args: Args) => Promise<Result>,
) {
  let entries: Readonly<Record<string, Promise<Result>>> = {};
  return (...args: Args): Promise<Result> => {
    const key = JSON.stringify(args);
    if (!entries[key]) {
      entries = { ...entries, [key]: Promise.resolve().then(() => call(...args)) };
    }
    return entries[key];
  };
}

/** Keep one bounded demo chat in memory; inspection snapshots are not refreshed within a chat. */
export function createChatSession(
  dependencies: {
    extract?: typeof extractExecutionRequests;
    inspect?: typeof runRepositoryInspection;
    extractWallet?: typeof extractWalletRequests;
  } = {},
) {
  const extract = cacheCalls(dependencies.extract ?? extractExecutionRequests);
  const inspect = cacheCalls(dependencies.inspect ?? runRepositoryInspection);
  const extractWallet = cacheCalls(dependencies.extractWallet ?? extractWalletRequests);
  let messages: readonly VisibleMessage[] = [];
  let busy = false;
  return {
    append(rawMessage: unknown) {
      if (busy) {
        throw new Error('Chat is already analysing a message.');
      }
      const parsed = messageSchema.parse(rawMessage);
      const message: VisibleMessage = {
        time: `t${messages.length}`,
        sender: parsed.sender === 'recruiter' ? 'counterparty' : 'candidate',
        message: parsed.message,
      };
      const nextMessages = [...messages, message];
      if (nextMessages.length > 20 || Buffer.byteLength(JSON.stringify(nextMessages)) > 64 * 1024) {
        throw new Error('Chat limit reached. Start a new chat.');
      }
      messages = nextMessages;
      busy = true;
      const steps = (async function* () {
        try {
          for await (const step of runConversation(
            { messages: nextMessages },
            extract,
            inspect,
            undefined,
            extractWallet,
          )) {
            if (step.time === message.time) {
              yield step;
            }
          }
        } finally {
          busy = false;
        }
      })();
      return { message, steps };
    },
  };
}

/** Validate and project a bounded demo replay before any agent work. */
export function parseReplayConversation(input: unknown) {
  const messages = parseConversation(input);
  if (messages.length > 20) {
    throw new Error('Demo accepts at most 20 messages.');
  }
  return messages;
}

/** Run a fresh conversation through V2; transport and session storage stay in the demo. */
export const runReplayConversation = runConversation;
