import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { replayRepositoryEvents } from '../repository-replay.ts';
import type { RepositoryReplayStep } from '../repository-replay.ts';
import { executionInstructions } from '../execution-extractor.ts';

async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--dry-run')) throw new Error('Only --dry-run is supported.');
    const raw = readFileSync('data/synthetic-repository-pair.json', 'utf8');
    const fixture = JSON.parse(raw);
    if (args.includes('--dry-run')) {
        console.log(`Ready: ${fixture.cases.length} synthetic cases; extraction uses messages, checks use scripted results, labels stay in scoring.`);
        return;
    }
    const report = {
        purpose: 'synthetic_repository_extraction_and_policy_replay',
        created_at: new Date().toISOString(), model: process.env.V2_ANNOTATION_MODEL ?? 'gpt-5.6-luna',
        source_file: 'data/synthetic-repository-pair.json',
        source_sha256: createHash('sha256').update(raw).digest('hex'),
        prompt_sha256: createHash('sha256').update(executionInstructions).digest('hex'),
        held_out: false,
        limitations: 'LLM extraction and repository-action rules are integrated. Inspection and company verification results are stipulated synthetic findings. No artifact is fetched or executed; no Bayesian probabilities, check selection, likelihoods, or decision costs are evaluated. Limited to one explicitly supplied assessment artifact per case.',
        status: 'running',
        results: [] as Array<{ evaluation_id: number; step: RepositoryReplayStep; expected_action: string | null; checkpoint_match: boolean | null }>,
        errors: [] as Array<{ evaluation_id: number; name: string; message: string }>,
    };
    mkdirSync('results', { recursive: true });
    const path = `results/repository-replay-${report.created_at.replace(/[:.]/g, '-')}.json`;
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    for (const scenario of fixture.cases) {
        try {
            // The replay gets only events and artifact scope; not scenario labels or checkpoints.
            for await (const step of replayRepositoryEvents(scenario.events, fixture.assessment_artifact)) {
                const expected = scenario.evaluator_only.checkpoints.find(
                    (checkpoint: { after_event: string }) => checkpoint.after_event === step.event_id,
                );
                report.results.push({ evaluation_id: scenario.evaluation_id, step,
                    expected_action: expected?.expected_action ?? null,
                    checkpoint_match: expected ? step.recommendation.action === expected.expected_action : null });
                writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
                console.log(`Case ${scenario.evaluation_id} ${step.event_id}: ${step.recommendation.action ?? 'no execution action'}`);
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
    console.log(`Checkpoint agreement: ${scored.filter(item => item.checkpoint_match).length}/${scored.length}. Report: ${path}`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Replay failed.'); process.exitCode = 1; });
