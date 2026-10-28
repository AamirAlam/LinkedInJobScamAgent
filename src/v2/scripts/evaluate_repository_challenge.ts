import { readFileSync } from 'node:fs';
import { executionInstructions, extractExecutionRequests } from '../execution-extractor.ts';
import { replayRepositoryEvents } from '../repository-replay.ts';
import type { RepositoryReplayStep } from '../repository-replay.ts';
import { createReport, writeReport, describeFailure } from '../report.ts';
import {
  CHALLENGE_SOURCE,
  hashEvaluationText,
  loadReviewedChallenge,
} from '../reviewed-evaluation.ts';

/** Run the reviewed synthetic challenge with live request extraction and scripted checks; no artifacts are fetched. */
export async function runChallenge(args: readonly string[]) {
  if (args.length > 1 || args.some((arg) => arg !== '--dry-run')) {
    throw new Error('Use --challenge [--dry-run].');
  }
  const prepared = loadReviewedChallenge();
  const { source, coverage, model, hashes } = prepared;
  if (args.includes('--dry-run')) {
    console.log(
      `Ready: ${coverage.selected.length} reviewed synthetic cases; ${coverage.plannedMessageCalls} recruiter annotation calls; no candidate calls or artifact fetches. Model, code and target-review hashes verified. No API calls made.`,
    );
    return;
  }
  const started = Date.now();
  let callTimings: {
    evaluation_id: number;
    visible_messages: number;
    duration_ms: number;
    status: string;
  }[] = [];
  let report = {
    schema_version: 2,
    purpose: 'reviewed_authored_repository_challenge',
    created_at: new Date().toISOString(),
    source_file: CHALLENGE_SOURCE,
    source_sha256: hashes.source,
    prompt_sha256: hashEvaluationText(executionInstructions),
    harness_sha256: hashEvaluationText(readFileSync(__filename, 'utf8')),
    preparation_sha256: hashEvaluationText(
      readFileSync(require.resolve('../reviewed-evaluation.ts'), 'utf8'),
    ),
    preflight_hashes: hashes,
    model: process.env.V2_ANNOTATION_MODEL ?? 'gpt-5.6-luna',
    belief_configuration: model,
    held_out: false,
    target_review: 'user_accepted_action_targets_only',
    coverage: {
      total_cases: source.cases.length,
      selected_cases: coverage.selected.length,
      selected_case_ids: coverage.selected.map((scenario) => scenario.evaluation_id),
      skipped_cases: coverage.skipped,
      planned_message_calls: coverage.plannedMessageCalls,
      proposed_target_case_ids: [] as number[],
    },
    limitations: [
      'Assistant-authored synthetic triplets; author knew the design. User reviewed policy targets, not actual repository findings. No independent held-out or real-world effectiveness claim.',
      'All inspections and authorisations are scripted. No repository is fetched or executed. This tests extraction and reaction to evidence, not live inspection accuracy or autonomous check selection.',
      'Balanced challenge mix is not traffic prevalence. The numerical model uses frozen old estimation IDs only, with no smoothing. Unsupported evidence retains the prior and safety HOLD.',
      'Ordinary-hiring costs are assumed. Verification cost and cumulative delay are not assigned; comparison reports terminal decision cost only.',
      'Call timings cover the extraction wrapper, including any SDK retries. Token usage, physical provider attempts and billed dollar costs are not available from the current extractor.',
    ],
    status: 'running',
    results: [] as {
      evaluation_id: number;
      step: RepositoryReplayStep;
      expected_action: string | null;
      checkpoint_match: boolean | null;
    }[],
    errors: [] as { evaluation_id: number; name: string; message: string }[],
    annotation_calls: callTimings,
    duration_ms: 0,
  };
  const path = createReport('repository-challenge', report, report.created_at);
  console.log(
    `Running ${coverage.selected.length} cases; ${coverage.plannedMessageCalls} planned recruiter calls. Synthetic research model, scripted evidence; no artifact execution. Report: ${path}`,
  );
  for (const scenario of coverage.selected) {
    try {
      for await (const step of replayRepositoryEvents(
        scenario.events,
        scenario.assessment_artifact,
        async (messages) => {
          const callStarted = Date.now();
          let status = 'failed';
          try {
            const annotation = await extractExecutionRequests(messages);
            status = 'complete';
            return annotation;
          } finally {
            callTimings = [
              ...callTimings,
              {
                evaluation_id: scenario.evaluation_id,
                visible_messages: messages.length,
                duration_ms: Date.now() - callStarted,
                status,
              },
            ];
          }
        },
        model,
      )) {
        const checkpoint = scenario.evaluator_only.checkpoints.find(
          (item) => item.after_event === step.event_id,
        );
        report = {
          ...report,
          results: [
            ...report.results,
            {
              evaluation_id: scenario.evaluation_id,
              step,
              expected_action: checkpoint?.expected_action ?? null,
              checkpoint_match: checkpoint
                ? step.recommendation.action === checkpoint.expected_action
                : null,
            },
          ],
          annotation_calls: callTimings,
          duration_ms: Date.now() - started,
        };
        writeReport(path, report);
        if (checkpoint) {
          console.log(
            `Case ${scenario.evaluation_id} ${step.event_id}: ${step.recommendation.action}; target ${checkpoint.expected_action}.`,
          );
        }
      }
    } catch (error) {
      report = {
        ...report,
        status: 'stopped_on_error',
        errors: [
          ...report.errors,
          { evaluation_id: scenario.evaluation_id, ...describeFailure(error) },
        ],
        annotation_calls: callTimings,
        duration_ms: Date.now() - started,
      };
      writeReport(path, report);
      throw new Error(
        `Challenge stopped at case ${scenario.evaluation_id}; partial report preserved: ${path}`,
        { cause: error },
      );
    }
  }
  report = { ...report, status: 'complete', duration_ms: Date.now() - started };
  writeReport(path, report);
  const checkpoints = report.results.filter((item) => item.checkpoint_match !== null);
  console.log(
    `Checkpoint agreement: ${checkpoints.filter((item) => item.checkpoint_match).length}/${checkpoints.length}. Annotation calls: ${callTimings.length}. Report: ${path}`,
  );
}

if (require.main === module) {
  runChallenge(process.argv.slice(2)).catch((error) => {
    console.error(describeFailure(error).message);
    // eslint-disable-next-line no-restricted-syntax -- CLI exit status is a process boundary side effect.
    process.exitCode = 1;
  });
}
