import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { replayRepositoryEvents, repositoryEventSchema } from './repository-replay.ts';
import type { RepositoryReplayStep, ReplayBeliefConfig } from './repository-replay.ts';
import { executionInstructions } from './execution-extractor.ts';

type Fixture = {
    assessment_artifact?: string;
    cases: Array<{
        evaluation_id: number;
        assessment_artifact?: string;
        events: unknown[];
        evaluator_only: {
            runner_scope?: string;
            review_status?: string;
            checkpoints: Array<{ after_event: string; expected_action: string }>;
        };
    }>;
};

// Preflight every selected case before incurring API costs. Metadata selects and
// scores cases only; it is never supplied to the extractor or belief updater.
export function prepareRepositoryCases(fixture: Fixture, benchmarkMode: boolean) {
    const selected: Array<Fixture['cases'][number] & { assessment_artifact: string }> = [];
    const skipped: Array<{ evaluation_id: number; reason: string }> = [];
    const caseIds = new Set<number>();
    let plannedMessageCalls = 0;
    for (const scenario of fixture.cases) {
        if (!Number.isInteger(scenario.evaluation_id) || caseIds.has(scenario.evaluation_id)) {
            throw new Error('Case IDs must be unique integers.');
        }
        caseIds.add(scenario.evaluation_id);
        if (benchmarkMode && scenario.evaluator_only.runner_scope !== 'repository_replay') {
            skipped.push({ evaluation_id: scenario.evaluation_id,
                reason: 'Outside repository runner scope; requires broader threat/check handling.' });
            continue;
        }
        const artifact = scenario.assessment_artifact ?? fixture.assessment_artifact;
        if (!artifact?.trim()) throw new Error(`Case ${scenario.evaluation_id}: missing assessment artifact.`);
        const seen = new Set<string>();
        const visibleArtifacts = new Set<string>();
        for (const raw of scenario.events) {
            const event = repositoryEventSchema.parse(raw);
            if (seen.has(event.event_id)) throw new Error(`Case ${scenario.evaluation_id}: duplicate event ID.`);
            if (event.kind === 'message') {
                plannedMessageCalls++;
                if (event.agent_input.sender === 'counterparty') {
                    for (const url of event.agent_input.message.match(/https?:\/\/[^\s<>"']+/g) ?? []) {
                        visibleArtifacts.add(url.replace(/[.,;)]*$/, ''));
                    }
                }
            } else if (!seen.has(event.requested_after_event) || event.check_id !== event.agent_input.check ||
                event.agent_input.artifact !== artifact || !visibleArtifacts.has(artifact)) {
                throw new Error(`Case ${scenario.evaluation_id}: invalid check ordering or artifact reference.`);
            }
            seen.add(event.event_id);
        }
        const checkpoints = new Set<string>();
        for (const checkpoint of scenario.evaluator_only.checkpoints) {
            if (!seen.has(checkpoint.after_event) || checkpoints.has(checkpoint.after_event) ||
                !['SAFE', 'HOLD', 'FLAG'].includes(checkpoint.expected_action)) {
                throw new Error(`Case ${scenario.evaluation_id}: invalid checkpoint.`);
            }
            checkpoints.add(checkpoint.after_event);
        }
        selected.push({ ...scenario, assessment_artifact: artifact });
    }
    if (!selected.length) throw new Error('No repository-compatible cases were selected.');
    return { selected, skipped, plannedMessageCalls };
}

export async function main() {
    const args = process.argv.slice(2);
    if (args[0] === '--conversation') {
        if (args.length < 2 || args.length > 3 || (args.length === 3 && args[2] !== '--dry-run')) {
            throw new Error('Use --conversation FILE.json [--dry-run].');
        }
        const { parseConversation, runConversation } = await import('./conversation-runner.ts');
        const messages = parseConversation(JSON.parse(readFileSync(args[1], 'utf8')));
        if (args[2] === '--dry-run') {
            console.log(`Ready: ${messages.length} messages; at most one repository inspection. No API calls made.`);
            return;
        }
        const report = { created_at: new Date().toISOString(), purpose: 'conversation_driven_repository_inspection',
            status: 'running', belief_update: 'none_no_real_likelihoods_configured',
            model: process.env.V2_ANNOTATION_MODEL ?? 'gpt-5.6-luna',
            source_sha256: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
            steps: [] as unknown[] };
        mkdirSync('results', { recursive: true });
        const path = `results/conversation-v2-${report.created_at.replace(/[:.]/g, '-')}.json`;
        writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
        for await (const step of runConversation({ messages })) {
            report.steps.push(step);
            writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
            console.log(`${step.time}: ${step.action} — ${step.reason}`);
        }
        report.status = 'complete';
        writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
        console.log(`Report: ${path}`);
        return;
    }
    if (args[0] === '--inspect-local' || args[0] === '--inspect-repo') {
        if (args.length !== 4 || args[2] !== '--action') {
            throw new Error('Use --inspect-local PATH or --inspect-repo HTTPS_URL followed by --action "requested command".');
        }
        const result = args[0] === '--inspect-repo'
            ? await (await import('./repository-inspection-cycle.ts')).runRepositoryInspection(args[1], args[3])
            : await (await import('./repository-inspector.ts')).inspectRepository(args[1], args[3]);
        mkdirSync('results', { recursive: true });
        const path = `results/repository-inspection-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        writeFileSync(path, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
        if ('recommendation' in result) {
            console.log(`Inspection: ${result.inspection.outcome}. Recommendation: ${result.recommendation.action}.`);
            console.log(result.recommendation.reason);
        } else console.log(`Inspection: ${result.outcome}. Authorisation is not verified by this check.`);
        console.log(`Report: ${path}`);
        return;
    }
    if (args.some(arg => !['--dry-run', '--synthetic-bayes', '--benchmark'].includes(arg))) {
        throw new Error('Use --dry-run, --synthetic-bayes and/or --benchmark.');
    }
    // Explicit reviewed exercise snapshot, not a production model or measured data.
    const beliefConfig: ReplayBeliefConfig | undefined = args.includes('--synthetic-bayes') ? {
        priorScam: 11 / 95,
        executionLikelihoods: { likelihoodGivenScam: 6 / 11, likelihoodGivenLegitimate: 21 / 84 },
        firstInspectionLikelihoods: {
            'repository_inspection:unresolved': { likelihoodGivenScam: 1 / 6, likelihoodGivenLegitimate: 1 / 21 },
            'repository_inspection:no_harmful_behaviour_found': { likelihoodGivenScam: 1 / 6, likelihoodGivenLegitimate: 20 / 21 },
        },
    } : undefined;
    const benchmarkMode = args.includes('--benchmark');
    const sourceFile = benchmarkMode ? 'data/synthesis/synthetic-benchmark-100.json'
        : 'data/synthesis/synthetic-repository-pair.json';
    const raw = readFileSync(sourceFile, 'utf8');
    const fixture: Fixture = JSON.parse(raw);
    const { selected, skipped, plannedMessageCalls } = prepareRepositoryCases(fixture, benchmarkMode);
    console.log(`Coverage: ${selected.length}/${fixture.cases.length} cases selected; ${skipped.length} unsupported; ${plannedMessageCalls} planned message API calls.`);
    if (args.includes('--dry-run')) {
        console.log(`Ready: ${selected.length} synthetic cases; extraction uses messages, checks use scripted results, labels stay in scoring. Belief mode: ${beliefConfig ? 'reviewed synthetic exercise (not deployment estimates)' : 'repository rules only'}.`);
        return;
    }
    const report = {
        schema_version: 2,
        coverage: { total_cases: fixture.cases.length, selected_cases: selected.length,
            planned_message_calls: plannedMessageCalls, skipped_cases: skipped,
            selected_case_ids: selected.map(scenario => scenario.evaluation_id),
            proposed_target_case_ids: selected.filter(scenario => scenario.evaluator_only.review_status === 'proposed_requires_human_review')
                .map(scenario => scenario.evaluation_id) },
        purpose: beliefConfig ? 'synthetic_repository_bayes_and_policy_replay' : 'synthetic_repository_extraction_and_policy_replay',
        belief_configuration: beliefConfig ?? null,
        created_at: new Date().toISOString(), model: process.env.V2_ANNOTATION_MODEL ?? 'gpt-5.6-luna',
        source_file: sourceFile,
        source_sha256: createHash('sha256').update(raw).digest('hex'),
        prompt_sha256: createHash('sha256').update(executionInstructions).digest('hex'),
        held_out: false,
        limitations: 'LLM extraction and repository-action rules are integrated. Inspection and company verification results are stipulated synthetic findings. No artifact is fetched or executed. Optional belief mode uses reviewed authored exercise proportions and assumed ordinary-hiring costs; it does not validate calibration or deployment priors. Harmful findings, authorisation and follow-up inspections have no numerical likelihood model. No active check selection or total-cost comparison is evaluated. Limited to one assessment artifact per case.',
        status: 'running',
        results: [] as Array<{ evaluation_id: number; step: RepositoryReplayStep; expected_action: string | null; checkpoint_match: boolean | null }>,
        errors: [] as Array<{ evaluation_id: number; name: string; message: string }>,
    };
    mkdirSync('results', { recursive: true });
    const path = `results/repository-replay-${report.created_at.replace(/[:.]/g, '-')}.json`;
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    for (const scenario of selected) {
        try {
            // The replay gets only events and artifact scope; not scenario labels or checkpoints.
            for await (const step of replayRepositoryEvents(scenario.events, scenario.assessment_artifact, undefined, beliefConfig)) {
                const expected = scenario.evaluator_only.checkpoints.find(
                    (checkpoint: { after_event: string }) => checkpoint.after_event === step.event_id,
                );
                report.results.push({ evaluation_id: scenario.evaluation_id, step,
                    expected_action: expected?.expected_action ?? null,
                    checkpoint_match: expected ? step.recommendation.action === expected.expected_action : null });
                writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
                const probability = step.probabilistic;
                const beliefText = probability
                    ? ` Last modelled scam belief: ${(probability.belief.scamProbability * 100).toFixed(2)}%` +
                        ` (${probability.lastUpdatedAtEvent ?? 'initial prior'}).` +
                        (probability.unmodelledEvidenceEventIds.length
                            ? ` Does not incorporate evidence at: ${probability.unmodelledEvidenceEventIds.join(', ')}.` : '')
                    : '';
                console.log(`Case ${scenario.evaluation_id} ${step.event_id}: ${step.recommendation.action ?? 'no execution action'} — ${step.recommendation.guidance}${beliefText}`);
            }
        } catch (error) {
            const failure = error as Error;
            report.errors.push({ evaluation_id: scenario.evaluation_id, name: failure.name,
                message: failure.message.replaceAll(process.env.OPENAI_API_KEY ?? '\u0000', '[REDACTED]').slice(0, 300) });
            report.status = 'stopped_on_error';
            writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
            console.error(`Replay stopped for case ${scenario.evaluation_id}. Report: ${path}`);
            process.exitCode = 1;
            return;
        }
    }
    report.status = 'complete';
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
    const scored = report.results.filter(item => item.checkpoint_match !== null);
    console.log(`Checkpoint agreement: ${scored.filter(item => item.checkpoint_match).length}/${scored.length} across ${selected.length} evaluated cases; ${skipped.length} unsupported cases excluded. Report: ${path}`);
}
if (require.main === module) {
    main().catch(error => { console.error(error instanceof Error ? error.message : 'V2 agent failed.'); process.exitCode = 1; });
}
