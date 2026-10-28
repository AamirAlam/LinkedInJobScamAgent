import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  directBaselineInstructions,
  decideDirectEvidence,
  projectBaselineEvidence,
  replayDirectEvidence,
} from '../direct-evidence-baseline.ts';
import {
  CHALLENGE_SOURCE,
  hashEvaluationText,
  loadReviewedChallenge,
} from '../reviewed-evaluation.ts';
import { createReport, writeReport, describeFailure } from '../report.ts';
import { summariseDecisions } from './compare_policies.ts';
import { ordinaryHiringCosts } from '../decision-policy.ts';

const actionSchema = z.enum(['SAFE', 'HOLD', 'FLAG']);
const referenceSchema = z.object({
  status: z.literal('complete'),
  errors: z.array(z.unknown()).length(0),
  source_file: z.literal(CHALLENGE_SOURCE),
  source_sha256: z.string(),
  model: z.string(),
  preflight_hashes: z.object({ model: z.string() }),
  coverage: z.object({ selected_case_ids: z.array(z.number().int()) }),
  annotation_calls: z.array(z.unknown()),
  results: z.array(
    z.object({
      evaluation_id: z.number().int(),
      step: z.object({
        event_id: z.string(),
        recommendation: z.object({
          action: actionSchema,
          scope: z.enum(['conversation_only', 'repository_execution']),
        }),
        assessment: z.object({
          executionRequested: z.boolean(),
          inspection: z.string(),
          assessmentAuthorisation: z.string(),
        }),
      }),
    }),
  ),
});
type BaselineStep = Awaited<ReturnType<ReturnType<typeof replayDirectEvidence>['next']>>['value'];
type CompletedStep = Exclude<BaselineStep, void>;

/** Validate the V2 reference and shared evidence/model identity before a direct-baseline run. */
export function prepareDirectBaseline(rawReference: string) {
  const prepared = loadReviewedChallenge();
  const reference = referenceSchema.parse(JSON.parse(rawReference));
  const modelId = process.env.V2_ANNOTATION_MODEL ?? 'gpt-5.6-luna';
  if (
    reference.source_sha256 !== prepared.hashes.source ||
    reference.preflight_hashes.model !== prepared.hashes.model ||
    reference.model !== modelId
  ) {
    throw new Error(
      'Baseline and V2 must share the frozen cases, model ID and research configuration.',
    );
  }
  if (
    !isDeepStrictEqual(
      reference.coverage.selected_case_ids,
      prepared.coverage.selected.map((scenario) => scenario.evaluation_id),
    )
  ) {
    throw new Error('V2 reference does not cover the same case set.');
  }
  for (const scenario of prepared.coverage.selected) {
    const eventIds = projectBaselineEvidence(scenario.events).map((event) => event.event_id);
    const actual = reference.results
      .filter((item) => item.evaluation_id === scenario.evaluation_id)
      .map((item) => item.step.event_id);
    if (!isDeepStrictEqual(actual, eventIds)) {
      throw new Error(`Incomplete V2 event sequence for case ${scenario.evaluation_id}.`);
    }
  }
  return { prepared, reference, modelId };
}

/** Run a sequential evidence-matched baseline; candidate events retain context without model calls. */
export async function runDirectBaseline(args: readonly string[]) {
  const [referenceFile, ...flags] = args;
  if (
    !referenceFile ||
    referenceFile.startsWith('--') ||
    flags.length > 1 ||
    flags.some((flag) => flag !== '--dry-run')
  ) {
    throw new Error('Use --challenge-baseline V2_REPORT.json [--dry-run].');
  }
  const rawReference = readFileSync(referenceFile, 'utf8');
  const { prepared, reference, modelId } = prepareDirectBaseline(rawReference);
  const plannedCalls = prepared.coverage.selected.reduce(
    (count, scenario) =>
      count +
      projectBaselineEvidence(scenario.events).filter(
        (event) => event.kind === 'check_result' || event.agent_input.sender === 'counterparty',
      ).length,
    0,
  );
  if (flags.includes('--dry-run')) {
    console.log(
      `Ready: ${prepared.coverage.selected.length} identical reviewed cases, ${plannedCalls} direct decisions on recruiter/check events, zero candidate calls. V2 used ${reference.annotation_calls.length} extraction calls. No API calls made.`,
    );
    return;
  }
  const createdAt = new Date().toISOString();
  const protocol = {
    protocol_version: 3,
    citation_contract: 'event_id_and_typed_source_field_with_exact_quote',
    revision_note:
      'Version 1 rejected structured outcome values; version 2 exposed field-label formatting errors. Version 3 separates event_id, source field and exact quote. Earlier partial runs and diagnostic are preserved. No action-policy, model-number or target changes.',
    purpose: 'direct_evidence_baseline_protocol',
    created_at: createdAt,
    source_sha256: prepared.hashes.source,
    v2_report: referenceFile,
    v2_report_sha256: hashEvaluationText(rawReference),
    model: modelId,
    prompt: directBaselineInstructions,
    prompt_sha256: hashEvaluationText(directBaselineInstructions),
    baseline_source_sha256: hashEvaluationText(
      readFileSync(require.resolve('../direct-evidence-baseline.ts'), 'utf8'),
    ),
    harness_sha256: hashEvaluationText(readFileSync(__filename, 'utf8')),
    actions: ['SAFE', 'HOLD', 'FLAG'],
    costs: ordinaryHiringCosts,
    planned_model_calls: plannedCalls,
    v2_annotation_calls: reference.annotation_calls.length,
    specified_after_V2_results: true,
    limits: [
      'New direct-model baseline, not the unchanged binary V1 baseline. Prompt specified after observing V2 outputs; this is development comparison, not preregistered independent holdout.',
      'Same supplied evidence and model alias, different call cadence and prompt. Check-result decisions need model calls here; V2 uses deterministic policy code. Not compute- or token-budget matched.',
      'Candidate replies do not trigger calls. No tools, real inspection, external browsing or code execution. Scripted findings are not independently verified.',
      'Quote provenance is checked; semantic support of explanations is not independently adjudicated. No supplied numerical prior/likelihood table or separate Bayesian updater.',
    ],
  };
  const protocolPath = createReport('direct-baseline-protocol', protocol, createdAt);
  let timings: {
    evaluation_id: number;
    arrived_events: number;
    duration_ms: number;
    status: string;
  }[] = [];
  const started = Date.now();
  let report = {
    purpose: 'direct_evidence_baseline_run',
    created_at: createdAt,
    protocol_file: protocolPath,
    protocol_sha256: hashEvaluationText(readFileSync(protocolPath, 'utf8')),
    source_file: CHALLENGE_SOURCE,
    source_sha256: prepared.hashes.source,
    model: modelId,
    status: 'running',
    results: [] as {
      evaluation_id: number;
      step: CompletedStep;
      expected_action: string | null;
      checkpoint_match: boolean | null;
      checkpoint_scope_match: boolean | null;
    }[],
    errors: [] as { evaluation_id: number; name: string; message: string }[],
    model_calls: timings,
    duration_ms: 0,
  };
  const reportPath = createReport('direct-baseline', report, createdAt);
  console.log(
    `Running ${plannedCalls} direct decisions. Immutable protocol: ${protocolPath}. Report: ${reportPath}`,
  );
  for (const scenario of prepared.coverage.selected) {
    try {
      for await (const step of replayDirectEvidence(scenario.events, async (events) => {
        const callStarted = Date.now();
        let status = 'failed';
        try {
          const decision = await decideDirectEvidence(events);
          status = 'complete';
          return decision;
        } finally {
          timings = [
            ...timings,
            {
              evaluation_id: scenario.evaluation_id,
              arrived_events: events.length,
              duration_ms: Date.now() - callStarted,
              status,
            },
          ];
        }
      })) {
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
                ? step.decision?.action === checkpoint.expected_action
                : null,
              checkpoint_scope_match: checkpoint
                ? step.decision?.scope === 'repository_execution'
                : null,
            },
          ],
          model_calls: timings,
          duration_ms: Date.now() - started,
        };
        writeReport(reportPath, report);
        if (checkpoint) {
          console.log(
            `Direct case ${scenario.evaluation_id} ${step.event_id}: ${step.decision?.action}; target ${checkpoint.expected_action}; scope ${step.decision?.scope}.`,
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
        model_calls: timings,
        duration_ms: Date.now() - started,
      };
      writeReport(reportPath, report);
      throw new Error(
        `Direct baseline stopped at case ${scenario.evaluation_id}; partial report preserved: ${reportPath}`,
        { cause: error },
      );
    }
  }
  report = { ...report, status: 'complete', duration_ms: Date.now() - started };
  writeReport(reportPath, report);
  const finalCases = prepared.source.cases.map((scenario) => {
    const events = projectBaselineEvidence(scenario.events);
    const finalId = events[events.length - 1].event_id;
    const direct = report.results.find(
      (row) => row.evaluation_id === scenario.evaluation_id && row.step.event_id === finalId,
    )?.step.decision;
    const v2 = reference.results.find(
      (row) => row.evaluation_id === scenario.evaluation_id && row.step.event_id === finalId,
    )!.step.recommendation;
    if (!direct) {
      throw new Error('Completed baseline lacks a final decision.');
    }
    return {
      id: scenario.evaluation_id,
      groundTruth: scenario.evaluator_only.ground_truth,
      direct,
      v2,
    };
  });
  const aligned = finalCases.every(
    (item) =>
      item.direct.scope === 'repository_execution' && item.v2.scope === 'repository_execution',
  );
  const comparison = {
    purpose: 'evidence_matched_direct_model_comparison',
    source_file: CHALLENGE_SOURCE,
    source_sha256: prepared.hashes.source,
    v2_report: referenceFile,
    baseline_report: reportPath,
    baseline_report_sha256: hashEvaluationText(readFileSync(reportPath, 'utf8')),
    protocol_file: protocolPath,
    identical_case_ids: finalCases.map((item) => item.id),
    terminal_scopes_aligned: aligned,
    direct_summary: aligned
      ? summariseDecisions(
          finalCases.map((item) => ({ groundTruth: item.groundTruth, action: item.direct.action })),
        )
      : null,
    v2_summary: summariseDecisions(
      finalCases.map((item) => ({ groundTruth: item.groundTruth, action: item.v2.action })),
    ),
    direct_checkpoint_action_matches: report.results.filter((row) => row.checkpoint_match === true)
      .length,
    direct_checkpoint_scope_matches: report.results.filter(
      (row) => row.checkpoint_scope_match === true,
    ).length,
    checkpoints: report.results.filter((row) => row.checkpoint_match !== null).length,
    baseline_model_calls: timings.length,
    v2_annotation_calls: reference.annotation_calls.length,
    final_cases: finalCases,
    limits: [
      ...protocol.limits,
      'Terminal costs exclude unknown labels, verification cost and cumulative delay. A scope mismatch prevents a comparable direct terminal-cost summary.',
    ],
  };
  const comparisonPath = `${reportPath}.comparison.json`;
  writeReport(comparisonPath, comparison, true);
  console.log(
    `Direct checkpoint actions: ${comparison.direct_checkpoint_action_matches}/${comparison.checkpoints}; scope: ${comparison.direct_checkpoint_scope_matches}/${comparison.checkpoints}. Comparison: ${comparisonPath}`,
  );
}
