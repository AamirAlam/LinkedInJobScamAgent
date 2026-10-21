import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { applyAutomatedSupplement } from '../automated-supplement.ts';
import { prepareManualReview } from '../manual-review.ts';

function fixture() {
  const scope = {
    inspection_boundary: 'repository_controlled_code',
    requested_action: 'npm run dev',
    artifact_revision: 'a'.repeat(40),
    inspected_files: ['package.json'],
    findings: [],
    gaps: [
      'Uninspected local path: lib/extra.ts.',
      'File-count budget reached; relevant paths remain uninspected.',
    ],
  };
  const original = {
    purpose: 'live_read_only_repository_inspection',
    inspection: {
      check: 'repository_inspection',
      artifact: 'https://github.com/example/repo',
      outcome: 'unresolved',
      finding: 'Missing coverage.',
      scope,
      file_hashes: [{ file: 'package.json', sha256: '1'.repeat(64) }],
    },
  };
  const raw = JSON.stringify(original);
  const supplement = {
    schema_version: 1,
    purpose: 'automated_repository_supplement',
    coverage: 'listed_files_only',
    original_report_sha256: createHash('sha256').update(raw).digest('hex'),
    inspection: {
      ...original.inspection,
      outcome: 'no_harmful_behaviour_found',
      scope: { ...scope, inspected_files: ['lib/extra.ts'], gaps: [] },
    },
    file_hashes: [{ file: 'lib/extra.ts', sha256: '2'.repeat(64) }],
    observations: [
      { file: 'lib/extra.ts', start_line: 1, end_line: 2, assessment: 'Inert fixture source.' },
    ],
  };
  return { raw, original, supplement };
}

test('subset supplement resolves named file gaps, retains broader coverage, and produces an honest human checklist', () => {
  const { raw, supplement } = fixture();
  const result = applyAutomatedSupplement(JSON.stringify(supplement), raw, 'original.json');
  assert.deepEqual(result.inspection.scope?.inspected_files, ['package.json', 'lib/extra.ts']);
  assert.deepEqual(result.resolved_named_gaps, ['Uninspected local path: lib/extra.ts.']);
  assert.deepEqual(result.inspection.scope?.gaps, [
    'File-count budget reached; relevant paths remain uninspected.',
  ]);
  assert.equal(result.inspection.outcome, 'unresolved');
  assert.equal(result.recommendation.action, 'HOLD');
  const handoff = prepareManualReview(JSON.stringify(result), 'combined.json');
  assert.equal(handoff.gap_reviews.length, 1);
  assert.equal(handoff.status, 'pending_human_review');
  assert.equal(handoff.human_review.reviewer, null);
});

test('mismatched provenance, missing observations, duplicate inventory and conflicting overlapping hashes are rejected', () => {
  const { raw, supplement } = fixture();
  const variants = [
    { ...supplement, original_report_sha256: '0'.repeat(64) },
    {
      ...supplement,
      inspection: { ...supplement.inspection, artifact: 'https://github.com/other/repo' },
    },
    ...['artifact_revision', 'requested_action', 'inspection_boundary'].map((field) => ({
      ...supplement,
      inspection: {
        ...supplement.inspection,
        scope: { ...supplement.inspection.scope, [field]: 'different' },
      },
    })),
    { ...supplement, observations: [] },
    { ...supplement, file_hashes: [...supplement.file_hashes, ...supplement.file_hashes] },
    {
      ...supplement,
      inspection: {
        ...supplement.inspection,
        scope: { ...supplement.inspection.scope, inspected_files: ['package.json'] },
      },
      file_hashes: [{ file: 'package.json', sha256: '2'.repeat(64) }],
      observations: [
        { file: 'package.json', start_line: 1, end_line: 1, assessment: 'Changed context.' },
      ],
    },
  ];
  for (const variant of variants) {
    assert.throws(() => applyAutomatedSupplement(JSON.stringify(variant), raw, 'original.json'));
  }
});

test('unresolved supplements do not clear named gaps and new gaps remain visible', () => {
  const { raw, supplement } = fixture();
  const unresolved = {
    ...supplement,
    inspection: {
      ...supplement.inspection,
      outcome: 'unresolved',
      scope: { ...supplement.inspection.scope, gaps: ['Dynamic target unresolved.'] },
    },
  };
  const result = applyAutomatedSupplement(JSON.stringify(unresolved), raw, 'original.json');
  assert.deepEqual(result.resolved_named_gaps, []);
  assert.ok(result.inspection.scope?.gaps.includes('Uninspected local path: lib/extra.ts.'));
  assert.ok(result.inspection.scope?.gaps.includes('Dynamic target unresolved.'));
});

test('harm from either assessment survives and a clean named-file review cannot authorise execution', () => {
  for (const harmInOriginal of [true, false]) {
    const { original, supplement } = fixture();
    const file = harmInOriginal ? 'package.json' : 'lib/extra.ts';
    const finding = {
      file,
      start_line: 1,
      end_line: 1,
      behaviour: 'Inert harmful fixture.',
      harmful: true,
    };
    const amendedOriginal = harmInOriginal
      ? {
          ...original,
          inspection: {
            ...original.inspection,
            outcome: 'harmful_behaviour_found',
            scope: { ...original.inspection.scope, findings: [finding] },
          },
        }
      : original;
    const raw = JSON.stringify(amendedOriginal);
    const amendedSupplement = {
      ...supplement,
      original_report_sha256: createHash('sha256').update(raw).digest('hex'),
      inspection: harmInOriginal
        ? supplement.inspection
        : {
            ...supplement.inspection,
            outcome: 'harmful_behaviour_found',
            scope: { ...supplement.inspection.scope, findings: [finding] },
          },
    };
    const result = applyAutomatedSupplement(
      JSON.stringify(amendedSupplement),
      raw,
      'original.json',
    );
    assert.equal(result.inspection.outcome, 'harmful_behaviour_found');
    assert.equal(result.recommendation.action, 'FLAG');
    assert.equal(result.assessment.assessmentAuthorisation, 'unresolved');
  }
});

test('resolved file-only coverage still requires separate recruiter authorisation', () => {
  const { original, supplement } = fixture();
  const updated = {
    ...original,
    inspection: {
      ...original.inspection,
      scope: { ...original.inspection.scope, gaps: ['Uninspected local path: lib/extra.ts.'] },
    },
  };
  const raw = JSON.stringify(updated);
  const linked = {
    ...supplement,
    original_report_sha256: createHash('sha256').update(raw).digest('hex'),
  };
  const result = applyAutomatedSupplement(JSON.stringify(linked), raw, 'original.json');
  assert.equal(result.inspection.outcome, 'no_harmful_behaviour_found');
  assert.equal(result.recommendation.action, 'HOLD');
  assert.equal(result.assessment.assessmentAuthorisation, 'unresolved');
});
