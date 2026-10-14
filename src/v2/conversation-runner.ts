import { z } from 'zod';
import { extractExecutionRequests, validateExecutionAnnotation, visibleMessages } from './execution-extractor.ts';
import type { ExecutionAnnotation, VisibleMessage } from './execution-extractor.ts';
import { parseRepositoryUrl } from './repository-source.ts';
import { runRepositoryInspection } from './repository-inspection-cycle.ts';

export function parseConversation(input: unknown): VisibleMessage[] {
    const parsed = z.object({ messages: z.array(z.object({ time: z.string().min(1),
        sender: z.enum(['candidate', 'counterparty', 'recruiter']), message: z.string().min(1),
    })).min(1).max(100) }).parse(input);
    return visibleMessages(parsed.messages.map(message => ({ ...message,
        sender: message.sender === 'recruiter' ? 'counterparty' : message.sender })));
}

// One inspection per conversation run. Subsequent instructions require a new
// assessment; no earlier scoped result silently authorises them. No synthetic prior.
export async function* runConversation(
    input: unknown,
    extract: (messages: readonly VisibleMessage[]) => Promise<ExecutionAnnotation> = extractExecutionRequests,
    inspect: typeof runRepositoryInspection = runRepositoryInspection,
) {
    const messages = parseConversation(input); // preflight before any paid/network work
    let inspected = false;
    let executionSeen = false;
    let flagged = false;
    for (let i = 0; i < messages.length; i++) {
        const prefix = messages.slice(0, i + 1);
        const current = messages[i];
        if (flagged || inspected) {
            yield { time: current.time, action: flagged ? 'FLAG' : 'HOLD',
                scope: 'repository_execution', inspection_triggered: false,
                reason: flagged ? 'Previously identified harmful behaviour remains unresolved.'
                    : 'Execution remains on hold; new instructions require reassessment. Existing inspection is not repeated.' };
            continue;
        }
        let annotation: ExecutionAnnotation;
        try { annotation = validateExecutionAnnotation(await extract(prefix), prefix); }
        catch {
            yield { time: current.time, action: 'HOLD', scope: 'conversation_only', inspection_triggered: false,
                reason: 'Execution-request extraction failed; no repository was fetched.' };
            continue;
        }
        if (annotation.status !== 'present') {
            yield { time: current.time, annotation, action: executionSeen || annotation.status === 'ambiguous' ? 'HOLD' : 'SAFE',
                scope: executionSeen ? 'repository_execution' : 'conversation_only', inspection_triggered: false,
                reason: executionSeen ? 'Earlier execution request remains unresolved.'
                    : 'No explicit execution request established. SAFE permits conversation only, never code execution.' };
            continue;
        }
        executionSeen = true;
        const request = prefix.find(message => message.time === annotation.first_explicit_request_message)!;
        // Require the URL in the execution-request message. Inferring which older
        // repository a later command refers to requires a separate binding model.
        const urls = new Set<string>();
        for (const raw of request.message.match(/https?:\/\/[^\s<>"'`]+/g) ?? []) {
            try { urls.add(parseRepositoryUrl(raw.replace(/[.,;)]*$/, '')).artifact); } catch { /* unsupported target */ }
        }
        if (urls.size !== 1) {
            yield { time: current.time, annotation, action: 'HOLD', scope: 'repository_execution', inspection_triggered: false,
                reason: 'Execution request must identify exactly one supported repository root URL; clarify the target.' };
            continue;
        }
        const artifact = [...urls][0];
        // Surface HOLD before slow source/API work. No unverified execution window.
        yield { time: current.time, annotation, artifact, action: 'HOLD', scope: 'repository_execution',
            inspection_triggered: true, reason: 'Execution request detected; inspecting source without executing it.' };
        inspected = true;
        try {
            const inspection = await inspect(artifact, request.message);
            flagged = inspection.recommendation.action === 'FLAG';
            yield { time: current.time, artifact, action: flagged ? 'FLAG' : 'HOLD', scope: 'repository_execution',
                inspection_triggered: false, inspection,
                reason: inspection.recommendation.reason };
        } catch {
            yield { time: current.time, artifact, action: 'HOLD', scope: 'repository_execution', inspection_triggered: false,
                reason: 'Inspection failed; execution remains on hold.' };
        }
    }
}
