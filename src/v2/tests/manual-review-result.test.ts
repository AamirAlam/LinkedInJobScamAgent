import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareManualReview } from '../manual-review.ts';
import { applyManualReview } from '../manual-review-result.ts';

const scope = {
  requested_action: 'npm start',
  artifact_revision: 'a'.repeat(40),
  inspected_files: ['package.json'],
  findings: [],
  gaps: ['Startup source unavailable.'],
};
const source = JSON.stringify({
  purpose: 'live_read_only_repository_inspection',
  inspection: {
    check: 'repository_inspection',
    artifact: 'https://github.com/example/demo',
    outcome: 'unresolved',
    finding: 'Missing source.',
    scope,
  },
});
const citation = {
  file: 'start.js',
  start_line: 1,
  end_line: 1,
  quote: '// inert test fixture',
  reason: 'Synthetic test evidence, not a real review.',
};
function completedReview() {
  const pending = prepareManualReview(source, 'original.json');
  return {
    ...pending,
    status: 'completed_human_review',
    gap_reviews: pending.gap_reviews.map((item) => ({
      ...item,
      status: 'resolved',
      evidence: [citation],
      reviewer_note: 'Synthetic source inspected.',
    })),
    human_review: {
      reviewer: 'Synthetic test reviewer',
      reviewed_at: '2026-10-14T00:00:00Z',
      elapsed_minutes: 12,
      revision_confirmed: true,
      outcome: 'no_harmful_behaviour_found',
      inspected_files: ['start.js'],
      findings: [],
      remaining_gaps: [],
      conclusion: 'Synthetic clean result.',
    },
  };
}
function apply(review: unknown, report = source) {
  return applyManualReview(JSON.stringify(review), report, 'original.json');
}

test('completed source review retains authorisation HOLD and does not create a scam probability', () => {
  const review = completedReview();
  const result = apply(review);
  assert.equal(result.assessment.inspection, 'no_harmful_behaviour_found');
  assert.equal(result.recommendation.action, 'HOLD');
  assert.equal(result.assessment.assessmentAuthorisation, 'unresolved');
  assert.match(result.belief_update, /not_applied/);
  assert.equal('scamProbability' in result, false);
  assert.equal(review.status, 'completed_human_review');
});

test('cited human harm flags, while inconclusive evidence preserves HOLD and its gaps', () => {
  const review = completedReview();
  const harmful = {
    ...review,
    human_review: {
      ...review.human_review,
      outcome: 'harmful_behaviour_found',
      findings: [{ ...citation, harmful: true }],
    },
  };
  assert.equal(apply(harmful).recommendation.action, 'FLAG');
  const unresolved = {
    ...review,
    gap_reviews: review.gap_reviews.map((item) => ({
      ...item,
      status: 'unresolved',
      evidence: [],
    })),
    human_review: {
      ...review.human_review,
      outcome: 'unresolved',
      revision_confirmed: false,
      inspected_files: [],
      remaining_gaps: scope.gaps,
    },
  };
  assert.equal(apply(unresolved).recommendation.action, 'HOLD');
});

test('pending, mismatched, omitted, duplicated, and uncited reviews cannot be applied', () => {
  const review = completedReview();
  const invalidReviews = [
    prepareManualReview(source, 'original.json'),
    { ...review, source_report_sha256: '0'.repeat(64) },
    { ...review, artifact: 'https://github.com/other/repo' },
    { ...review, scope: { ...scope, artifact_revision: 'b'.repeat(40) } },
    { ...review, scope: { ...scope, requested_action: 'other command' } },
    { ...review, gap_reviews: [] },
    { ...review, gap_reviews: [...review.gap_reviews, ...review.gap_reviews] },
    { ...review, gap_reviews: review.gap_reviews.map((item) => ({ ...item, evidence: [] })) },
    { ...review, human_review: { ...review.human_review, revision_confirmed: false } },
    { ...review, human_review: { ...review.human_review, inspected_files: [] } },
    { ...review, human_review: { ...review.human_review, outcome: 'harmful_behaviour_found' } },
    { ...review, human_review: { ...review.human_review, outcome: 'unresolved' } },
  ];
  for (const invalid of invalidReviews) {
    assert.throws(() => apply(invalid));
  }
  assert.throws(() => apply(review, source + '\n'), /hash/);
});

test('invalid citation ranges, unsafe paths, and missing unresolved gaps are rejected', () => {
  const review = completedReview();
  for (const evidence of [
    { ...citation, start_line: 5, end_line: 2 },
    { ...citation, file: '../secret' },
  ]) {
    assert.throws(() =>
      apply({
        ...review,
        gap_reviews: review.gap_reviews.map((item) => ({ ...item, evidence: [evidence] })),
      }),
    );
  }
  assert.throws(
    () =>
      apply({
        ...review,
        gap_reviews: review.gap_reviews.map((item) => ({
          ...item,
          status: 'unresolved',
          evidence: [],
        })),
        human_review: {
          ...review.human_review,
          outcome: 'unresolved',
          remaining_gaps: ['Different gap.'],
        },
      }),
    /original gaps/,
  );
});

test('disputing an earlier harmful finding cannot silently downgrade FLAG', () => {
  const finding = {
    file: 'package.json',
    start_line: 1,
    end_line: 1,
    behaviour: 'Synthetic harm.',
    harmful: true,
  };
  const harmfulSource = JSON.stringify({
    purpose: 'live_read_only_repository_inspection',
    inspection: {
      check: 'repository_inspection',
      artifact: 'https://github.com/example/demo',
      outcome: 'harmful_behaviour_found',
      finding: 'Synthetic harm.',
      scope: { ...scope, gaps: [], findings: [finding] },
    },
  });
  const pending = prepareManualReview(harmfulSource, 'original.json');
  const review = {
    ...completedReview(),
    ...pending,
    status: 'completed_human_review',
    human_review: completedReview().human_review,
    finding_reviews: pending.finding_reviews.map((item) => ({
      ...item,
      status: 'disputed',
      evidence: [citation],
      reviewer_note: 'Synthetic dispute.',
    })),
  };
  assert.equal(apply(review, harmfulSource).recommendation.action, 'FLAG');
  assert.throws(() => apply({ ...review, finding_reviews: [] }, harmfulSource), /every original/);
});

test('offline CLI writes a separate assessment and refuses a pending review without changing originals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v2-human-review-'));
  try {
    const sourcePath = join(directory, 'source.json');
    const reviewPath = join(directory, 'review.json');
    await writeFile(sourcePath, source);
    await writeFile(reviewPath, JSON.stringify(completedReview()));
    const args = [
      '--import',
      require.resolve('tsx'),
      resolve(__dirname, '../agent-v2.ts'),
      '--apply-review',
      reviewPath,
      '--source',
      sourcePath,
    ];
    const applied = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /Recommendation: HOLD/);
    const reports = await readdir(join(directory, 'results'));
    assert.equal(reports.length, 1);
    assert.equal(await readFile(sourcePath, 'utf8'), source);

    await writeFile(reviewPath, JSON.stringify(prepareManualReview(source, sourcePath)));
    const rejected = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.deepEqual(await readdir(join(directory, 'results')), reports);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
