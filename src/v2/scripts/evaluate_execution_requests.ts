import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extractExecutionRequests, executionInstructions, visibleMessages, visibleMessagePrefixes } from '../execution-extractor.ts';
import type { ExecutionAnnotation, VisibleMessage } from '../execution-extractor.ts';

type Case = { evaluation_id: number; messages: VisibleMessage[] };
type Reference = { evaluation_id: number; review_status: string; reviewed_annotation: ExecutionAnnotation };

async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--all', '--dry-run', '--prefixes'].includes(arg) && !/^--case=\d+$/.test(arg))) {
        throw new Error('Use --all, --case=ID, --prefixes, and/or --dry-run.');
    }
    const caseArgs = args.filter(arg => arg.startsWith('--case='));
    if (caseArgs.length > 1 || (caseArgs.length && args.includes('--all'))) {
        throw new Error('Select either --all or one --case=ID.');
    }
    const raw = readFileSync('data/july-conversations.json', 'utf8');
    const cases: Case[] = JSON.parse(raw);
    const references: Reference[] = ['code-execution-pilot.json', 'code-execution-proposals.json']
        .flatMap(name => JSON.parse(readFileSync(`data/${name}`, 'utf8')).annotations);
    const byId = new Map(references.map(reference => [reference.evaluation_id, reference]));
    const prefixMode = args.includes('--prefixes');
    const pilotIds = prefixMode ? [6, 31, 38, 41, 44, 45] : [6, 31, 41, 44, 45];
    const selectedIds = caseArgs.length ? [Number(caseArgs[0].split('=')[1])] : pilotIds;
    const selected = (args.includes('--all') ? cases : selectedIds.map(id => cases.find(item => item.evaluation_id === id))) as Case[];
    for (const item of selected) {
        if (!item || !byId.get(item.evaluation_id)?.reviewed_annotation) throw new Error('Case or reviewed reference missing.');
        visibleMessages(item.messages);
        const reference = byId.get(item.evaluation_id)!;
        if (!['accepted', 'corrected'].includes(reference.review_status)) throw new Error('Human review is incomplete.');
        if (reference.reviewed_annotation.status === 'present' &&
            !item.messages.some(message => message.time === reference.reviewed_annotation.first_explicit_request_message && message.sender === 'counterparty')) {
            throw new Error('Reviewed first-request reference is missing.');
        }
    }
    const tasks = selected.flatMap(item =>
        (prefixMode ? visibleMessagePrefixes(item.messages) : [visibleMessages(item.messages)])
            .map(messages => ({ item, messages })),
    );
    if (args.includes('--dry-run')) {
        console.log(`Ready: ${selected.length} conversations, ${tasks.length} ${prefixMode ? 'prefix' : 'full-conversation'} checks; API inputs contain time, sender, and message only.`);
        return;
    }
    const model = process.env.V2_ANNOTATION_MODEL ?? 'gpt-5.6-luna';
    const report = {
        purpose: prefixMode ? 'development_execution_prefix_comparison' : 'development_execution_annotation_comparison',
        model, created_at: new Date().toISOString(),
        source_file: 'data/july-conversations.json',
        source_sha256: createHash('sha256').update(raw).digest('hex'),
        prompt_sha256: createHash('sha256').update(executionInstructions).digest('hex'),
        prompt: executionInstructions,
        held_out: false,
        limitations: prefixMode
            ? 'Sequential visible prefixes, independently re-annotated without passing previous model outputs. Presence constraints are derived from full-conversation human reviews, not independently reviewed prefix labels. Earlier absent versus ambiguous states are not scored exactly. Prefix checks are correlated within each case. No scam classification, likelihoods, inspection, or end-to-end policy is evaluated.'
            : 'Full visible conversations, not sequential replay. Only execution-request annotations are scored; no scam classification, likelihoods, or inspection are evaluated. Human-reviewed targets were available during development but are withheld from API inputs.',
        planned_cases: selected.length,
        planned_checks: tasks.length,
        status: 'running',
        results: [] as Array<{ evaluation_id: number; observed_through: string; message_count: number; predicted: ExecutionAnnotation; expected: ExecutionAnnotation; expected_present: boolean; expected_status: ExecutionAnnotation['status'] | null; presence_match: boolean; status_match: boolean | null; first_request_match: boolean }>,
        errors: [] as Array<{ evaluation_id: number; observed_through: string; name: string; status?: number; code?: string; message: string; rejected_annotation?: unknown }>,
    };
    mkdirSync('results', { recursive: true });
    const path = `results/execution-${prefixMode ? 'prefixes' : 'annotations'}-${report.created_at.replace(/[:.]/g, '-')}.json`;
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    for (const { item, messages } of tasks) {
        const through = messages[messages.length - 1].time;
        try {
            const predicted = await extractExecutionRequests(messages, model);
            const expected = byId.get(item.evaluation_id)!.reviewed_annotation;
            const requestIndex = item.messages.findIndex(message => message.time === expected.first_explicit_request_message);
            const expectedPresent = expected.status === 'present' && messages.length > requestIndex;
            const isFinal = messages.length === item.messages.length;
            const expectedStatus = isFinal ? expected.status : expectedPresent ? 'present' : null;
            report.results.push({ evaluation_id: item.evaluation_id, observed_through: through, message_count: messages.length,
                predicted, expected, expected_present: expectedPresent, expected_status: expectedStatus,
                presence_match: (predicted.status === 'present') === expectedPresent,
                status_match: expectedStatus === null ? null : predicted.status === expectedStatus,
                first_request_match: predicted.first_explicit_request_message === (expectedPresent ? expected.first_explicit_request_message : null) });
            console.log(`Case ${item.evaluation_id} through ${through}: ${predicted.status}; ${expectedPresent ? 'request expected' : 'no explicit request expected'}`);
        } catch (error) {
            const failure = error as Error & { status?: number; code?: string; rejectedAnnotation?: unknown };
            const message = failure.message.replaceAll(process.env.OPENAI_API_KEY ?? '\u0000', '[REDACTED]').slice(0, 300);
            report.errors.push({ evaluation_id: item.evaluation_id, observed_through: through, name: failure.name, status: failure.status, code: failure.code,
                message, rejected_annotation: failure.rejectedAnnotation });
            report.status = 'stopped_on_error';
            // Save completed cases without logging API credentials, request bodies, or raw errors.
            writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
            console.error(`Stopped at case ${item.evaluation_id} through ${through}: ${failure.name}; HTTP ${failure.status ?? 'unavailable'}. Report: ${path}`);
            process.exitCode = 1;
            return;
        }
        writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
    }
    report.status = 'complete';
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
    if (prefixMode) {
        const matches = report.results.filter(item => item.presence_match).length;
        console.log(`Presence-constraint agreement: ${matches}/${report.results.length} prefixes across ${selected.length} cases. Report: ${path}`);
    } else {
        const matches = report.results.filter(item => item.status_match).length;
        console.log(`Status agreement: ${matches}/${report.results.length}. Report: ${path}`);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Execution annotation evaluation failed.');
    process.exitCode = 1;
});
