import { z } from 'zod';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { ordinaryHiringCosts } from '../decision-policy.ts';
import type { Action } from '../decision-cost.ts';

const actionSchema = z.enum(['SAFE', 'HOLD', 'FLAG']);
const groundTruthSchema = z.enum(['scam', 'legitimate', 'unknown']);
const comparisonReportSchema = z.object({
  status: z.string(),
  errors: z.array(z.unknown()),
  source_file: z.string(),
  source_sha256: z.string(),
  coverage: z.object({
    selected_case_ids: z.array(z.number().int()),
    skipped_cases: z.array(z.unknown()),
  }),
  results: z.array(
    z.object({
      evaluation_id: z.number().int(),
      step: z.object({
        event_id: z.string(),
        recommendation: z.object({ action: actionSchema }),
        probabilistic: z.object({ decision: z.object({ costAction: actionSchema }) }).optional(),
      }),
    }),
  ),
});
const comparisonSourceSchema = z.object({
  cases: z.array(
    z.object({
      evaluation_id: z.number().int(),
      events: z.array(z.object({ event_id: z.string() })),
      evaluator_only: z.object({ ground_truth: groundTruthSchema }),
    }),
  ),
});

type ScoredCase = { groundTruth: 'scam' | 'legitimate' | 'unknown'; action: Action };

/** Score final actions; unknown labels do not contribute to cost or binary metrics. */
export function summariseDecisions(cases: ScoredCase[]) {
  let cost = 0,
    known = 0,
    scams = 0,
    legitimate = 0;
  let safeOnScam = 0,
    flagOnLegitimate = 0,
    flaggedScams = 0,
    knownFlags = 0,
    holdKnown = 0,
    holdUnknown = 0;
  for (const item of cases) {
    if (
      !['SAFE', 'HOLD', 'FLAG'].includes(item.action) ||
      !['scam', 'legitimate', 'unknown'].includes(item.groundTruth)
    ) {
      throw new Error('Unsupported action or ground truth.');
    }
    if (item.groundTruth === 'unknown') {
      if (item.action === 'HOLD') {
        holdUnknown++;
      }
      continue;
    }
    known++;
    cost += ordinaryHiringCosts[item.action][item.groundTruth];
    if (item.action === 'HOLD') {
      holdKnown++;
    }
    if (item.action === 'FLAG') {
      knownFlags++;
    }
    if (item.groundTruth === 'scam') {
      scams++;
      if (item.action === 'SAFE') {
        safeOnScam++;
      }
      if (item.action === 'FLAG') {
        flaggedScams++;
      }
    } else {
      legitimate++;
      if (item.action === 'FLAG') {
        flagOnLegitimate++;
      }
    }
  }
  return {
    cases: cases.length,
    known,
    unknown: cases.length - known,
    scams,
    legitimate,
    terminal_decision_cost: cost,
    safe_on_scam: safeOnScam,
    flag_on_legitimate: flagOnLegitimate,
    hold_known: holdKnown,
    hold_unknown: holdUnknown,
    flag_precision: knownFlags ? flaggedScams / knownFlags : null,
    flag_recall: scams ? flaggedScams / scams : null,
  };
}

/** Compare completed replay policies against the unchanged source snapshot. */
export function main() {
  const [reportPath, ...extra] = process.argv.slice(2);
  if (!reportPath || extra.length) {
    throw new Error('Pass one completed repository-replay report path.');
  }
  const { rawReport, report, selectedIds, finalCases } = loadComparisonCases(reportPath);
  const policies = compareFinalPolicies(finalCases);
  const comparison = {
    purpose: 'synthetic_terminal_decision_cost_comparison',
    source_report: reportPath,
    report_sha256: createHash('sha256').update(rawReport).digest('hex'),
    source_file: report.source_file,
    source_sha256: report.source_sha256,
    case_ids: selectedIds,
    skipped_case_count: report.coverage.skipped_cases.length,
    costs: ordinaryHiringCosts,
    cost_basis: 'Student-assumed relative units; ordinary hiring with HOLD up to 24 hours.',
    policies,
    verification_cost: null,
    limitations: [
      'One final decision per case, not cumulative trajectory cost. Intermediate HOLDs and earlier actions are not charged.',
      'Unknown states are excluded from decision cost and binary precision/recall; their HOLD count is reported separately.',
      'P0 always SAFE is a fixed no-evidence baseline. The other constant policies are additional references.',
      'Cost-only reuses the exact V2 observation/belief trajectory; it is a diagnostic without safety overrides, not an independently run evidence-selection policy.',
      'Verification money/time/attention costs have not been assigned. This is not total operational cost.',
      'Authored synthetic findings and proposed targets; only the supported subset is scored, not all 100 cases. No claim of held-out calibration or real-world effectiveness.',
    ],
  };
  const output = reportPath.replace(/\.json$/, '') + '.policy-comparison.json';
  writeFileSync(output, JSON.stringify(comparison, null, 2) + '\n', { flag: 'wx' });
  console.table(
    policies.map((policy) => ({
      policy: policy.policy,
      cost: policy.terminal_decision_cost,
      SAFE_on_scam: policy.safe_on_scam,
      FLAG_on_legitimate: policy.flag_on_legitimate,
      HOLD_known: policy.hold_known,
      HOLD_unknown: policy.hold_unknown,
    })),
  );
  console.log(
    `Scored ${finalCases.length} identical cases; unknowns excluded from cost. Verification costs unassigned. Report: ${output}`,
  );
}

function loadComparisonCases(reportPath: string) {
  const rawReport = readFileSync(reportPath, 'utf8');
  const report = comparisonReportSchema.parse(JSON.parse(rawReport));
  assert.equal(report.status, 'complete', 'Only completed runs can be compared.');
  assert.equal(report.errors.length, 0, 'Run has errors.');
  const rawSource = readFileSync(report.source_file, 'utf8');
  assert.equal(
    createHash('sha256').update(rawSource).digest('hex'),
    report.source_sha256,
    'Dataset has changed since this run; use its original snapshot.',
  );
  const source = comparisonSourceSchema.parse(JSON.parse(rawSource));
  const selectedIds: number[] = report.coverage.selected_case_ids;
  assert.equal(new Set(selectedIds).size, selectedIds.length);
  assert.equal(new Set(report.results.map((item) => item.evaluation_id)).size, selectedIds.length);
  const finalCases = selectedIds.map((id) => {
    const scenario = source.cases.find((item) => item.evaluation_id === id);
    assert.ok(scenario, `Missing case ${id}`);
    const steps = report.results
      .filter((item) => item.evaluation_id === id)
      .map((item) => item.step);
    assert.deepEqual(
      steps.map((step) => step.event_id),
      scenario.events.map((event) => event.event_id),
      `Incomplete or reordered events in case ${id}`,
    );
    const final = steps[steps.length - 1];
    assert.ok(final.probabilistic, 'Comparison requires a synthetic-bayes run.');
    return {
      id,
      groundTruth: scenario.evaluator_only.ground_truth,
      finalAction: final.recommendation.action,
      costOnlyAction: final.probabilistic.decision.costAction,
    };
  });
  return { rawReport, report, selectedIds, finalCases };
}

function compareFinalPolicies(finalCases: ReturnType<typeof loadComparisonCases>['finalCases']) {
  return [
    {
      name: 'P0: always SAFE',
      actions: finalCases.map((item) => ({
        groundTruth: item.groundTruth,
        action: 'SAFE' as const,
      })),
    },
    {
      name: 'Always HOLD',
      actions: finalCases.map((item) => ({
        groundTruth: item.groundTruth,
        action: 'HOLD' as const,
      })),
    },
    {
      name: 'Always FLAG',
      actions: finalCases.map((item) => ({
        groundTruth: item.groundTruth,
        action: 'FLAG' as const,
      })),
    },
    {
      name: 'Cost-only diagnostic',
      actions: finalCases.map((item) => ({
        groundTruth: item.groundTruth,
        action: item.costOnlyAction,
      })),
    },
    {
      name: 'V2 cost + safety',
      actions: finalCases.map((item) => ({
        groundTruth: item.groundTruth,
        action: item.finalAction,
      })),
    },
  ].map((policy) => ({ policy: policy.name, ...summariseDecisions(policy.actions) }));
}

if (require.main === module) {
  main();
}
