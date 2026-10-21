import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { prepareManualReview } from '../manual-review.ts';

const inspection = {
  check: 'repository_inspection',
  artifact: 'https://github.com/example/demo',
  outcome: 'unresolved',
  finding: 'Required source is unavailable.',
  scope: {
    requested_action: 'npm start',
    artifact_revision: 'a'.repeat(40),
    inspected_files: ['package.json'],
    findings: [],
    gaps: ['Startup script is unavailable.'],
  },
};
const cycle = { purpose: 'live_read_only_repository_inspection', inspection };

test('manual handoff preserves scope and provenance without inventing a verdict or review time', () => {
  const raw = JSON.stringify(cycle);
  const result = prepareManualReview(raw, 'saved-report.json');
  assert.deepEqual(result.scope, inspection.scope);
  assert.equal(result.source_report_sha256, createHash('sha256').update(raw).digest('hex'));
  assert.equal(result.gap_reviews[0].status, 'pending');
  assert.equal(result.human_review.outcome, null);
  assert.equal(result.human_review.elapsed_minutes, null);
  assert.equal(result.human_review.revision_confirmed, false);
  assert.equal(result.policy_effect, 'none_handoff_only');
  assert.equal(inspection.scope.gaps.length, 1);
});

test('completed conversation report extracts the single inspection without copying conversation labels', () => {
  const result = prepareManualReview(
    JSON.stringify({
      purpose: 'conversation_driven_repository_inspection',
      status: 'complete',
      ground_truth: 'scam',
      steps: [{ time: 't0', action: 'SAFE' }, { inspection: cycle }],
    }),
    'conversation.json',
  );
  assert.deepEqual(result.scope, inspection.scope);
  assert.equal('ground_truth' in result, false);
  assert.equal('steps' in result, false);
});

test('handoff refuses ambiguous, incomplete, or scopeless reports instead of selecting evidence silently', () => {
  for (const steps of [[], [{ inspection: cycle }, { inspection: cycle }]]) {
    assert.throws(
      () =>
        prepareManualReview(
          JSON.stringify({
            purpose: 'conversation_driven_repository_inspection',
            status: 'complete',
            steps,
          }),
          'invalid.json',
        ),
      /exactly one/,
    );
  }
  assert.throws(
    () =>
      prepareManualReview(
        JSON.stringify({
          ...cycle,
          inspection: { ...inspection, scope: undefined },
        }),
        'invalid.json',
      ),
    /scope/,
  );
  assert.throws(() =>
    prepareManualReview(
      JSON.stringify({
        purpose: 'conversation_driven_repository_inspection',
        status: 'running',
        steps: [{ inspection: cycle }],
      }),
      'invalid.json',
    ),
  );
  assert.throws(
    () =>
      prepareManualReview(
        JSON.stringify({
          ...cycle,
          inspection: { ...inspection, outcome: 'no_harmful_behaviour_found' },
        }),
        'invalid.json',
      ),
    /unresolved execution-path gaps/,
  );
});
