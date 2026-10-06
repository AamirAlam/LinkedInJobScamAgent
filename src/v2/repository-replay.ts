import { z } from 'zod';
import { extractExecutionRequests, validateExecutionAnnotation, visibleMessages } from './execution-extractor.ts';
import type { ExecutionAnnotation, VisibleMessage } from './execution-extractor.ts';
import { recommendRepositoryAction } from './repository-policy.ts';
import type { RepositoryAssessment } from './repository-policy.ts';

const eventSchema = z.discriminatedUnion('kind', [
    z.object({
        event_id: z.string().min(1), kind: z.literal('message'),
        agent_input: z.object({ sender: z.enum(['candidate', 'counterparty']), message: z.string() }),
    }),
    z.object({
        event_id: z.string().min(1), kind: z.literal('check_result'),
        check_id: z.string(), requested_after_event: z.string(),
        agent_input: z.discriminatedUnion('check', [
            z.object({ check: z.literal('repository_inspection'), artifact: z.string(),
                outcome: z.enum(['unresolved', 'no_harmful_behaviour_found', 'harmful_behaviour_found']),
                finding: z.string().min(1), limitations: z.string().optional() }),
            z.object({ check: z.literal('assessment_authorisation'), artifact: z.string(),
                outcome: z.enum(['unresolved', 'verified']), finding: z.string().min(1) }),
        ]),
    }),
]);

export type RepositoryReplayStep = {
    event_id: string;
    annotation: ExecutionAnnotation | null;
    assessment: RepositoryAssessment;
    recommendation: ReturnType<typeof recommendRepositoryAction>;
};

// One known repository assessment; checks are supplied by the caller, not performed here.
// No ground truth, expected actions, or previous model outputs enter extraction.
export async function* replayRepositoryEvents(
    events: readonly unknown[],
    assessmentArtifact: string,
    extract: (messages: readonly VisibleMessage[]) => Promise<ExecutionAnnotation> = extractExecutionRequests,
): AsyncGenerator<RepositoryReplayStep> {
    if (!assessmentArtifact.trim()) throw new Error('Assessment artifact is required.');
    let assessment: RepositoryAssessment = {
        executionRequested: false, inspection: 'pending', assessmentAuthorisation: 'unresolved',
    };
    const messages: VisibleMessage[] = [];
    const seenEvents = new Set<string>();
    for (const rawEvent of events) {
        const event = eventSchema.parse(rawEvent); // strips reviewer metadata
        if (seenEvents.has(event.event_id)) throw new Error('Duplicate event ID.');
        let annotation: ExecutionAnnotation | null = null;
        if (event.kind === 'message') {
            messages.push({ time: event.event_id, ...event.agent_input });
            const prefix = visibleMessages(messages);
            annotation = validateExecutionAnnotation(await extract(prefix), prefix);
            assessment = { ...assessment, executionRequested: assessment.executionRequested || annotation.status === 'present' };
        } else {
            const input = event.agent_input;
            if (event.check_id !== input.check || !seenEvents.has(event.requested_after_event)) {
                throw new Error('Check result must reference an earlier event and the matching check.');
            }
            if (input.artifact !== assessmentArtifact || !messages.some(message =>
                message.sender === 'counterparty' &&
                (message.message.match(/https?:\/\/[^\s<>"']+/g) ?? []).some(url =>
                    url.replace(/[.,;)]*$/, '') === assessmentArtifact))) {
                throw new Error('Check result must concern the repository visible in this assessment.');
            }
            if (input.check === 'repository_inspection') {
                // Known harmful behaviour is not erased by a later incomplete clean check.
                if (assessment.inspection !== 'harmful_behaviour_found') {
                    assessment = { ...assessment, inspection: input.outcome };
                }
            } else {
                assessment = { ...assessment, assessmentAuthorisation: input.outcome };
            }
        }
        seenEvents.add(event.event_id);
        yield { event_id: event.event_id, annotation, assessment, recommendation: recommendRepositoryAction(assessment) };
    }
}
