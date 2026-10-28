import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  CHALLENGE_SOURCE,
  CHALLENGE_REVIEWS,
  hashEvaluationText,
  loadReviewedChallenge,
  validateChallengeReviews,
} from '../reviewed-evaluation.ts';
import { runChallenge } from '../scripts/evaluate_repository_challenge.ts';

const readText = (path: string) => readFileSync(path, 'utf8');
const rawSource = readText(CHALLENGE_SOURCE);
const rawReviews = readText(CHALLENGE_REVIEWS);
type Review = {
  evaluation_id: number;
  status: string;
  accepted_checkpoints: { after_event: string; expected_action: string }[];
};

test('reviewed challenge preflight validates all 24 targets, 56 recruiter calls and frozen estimation model', () => {
  const prepared = loadReviewedChallenge();
  assert.equal(prepared.coverage.selected.length, 24);
  assert.equal(prepared.coverage.skipped.length, 0);
  assert.equal(prepared.coverage.plannedMessageCalls, 56);
  assert.equal(prepared.model.priorScam, 8 / 63);
  assert.equal(prepared.hashes.source, hashEvaluationText(rawSource));
  assert.equal(prepared.source.held_out, false);
});

test('target reviews reject incomplete, duplicate, stale and source-mismatched acceptance', () => {
  const reviews: { reviews: Review[]; source_sha256: string } = JSON.parse(rawReviews);
  const validate = (value: unknown) =>
    validateChallengeReviews(rawSource, JSON.stringify(value), CHALLENGE_SOURCE);
  assert.throws(() => validate({ ...reviews, reviews: reviews.reviews.slice(1) }), /exactly one/);
  assert.throws(
    () =>
      validate({
        ...reviews,
        reviews: reviews.reviews.map((review, index) =>
          index === 1 ? reviews.reviews[0] : review,
        ),
      }),
    /exactly one/,
  );
  assert.throws(
    () =>
      validate({
        ...reviews,
        reviews: reviews.reviews.map((review, index) =>
          index ? review : { ...review, accepted_checkpoints: [] },
        ),
      }),
    /missing or stale/,
  );
  assert.throws(() => validate({ ...reviews, source_sha256: '0'.repeat(64) }), /source snapshot/);
  assert.throws(() => validate({ ...reviews, pending_case_ids: [1001] }));
});

test('frozen-code and model tampering fail before any model calls', () => {
  assert.throws(
    () =>
      loadReviewedChallenge((path) =>
        path === 'src/v2/conversation-runner.ts' ? `${readText(path)}\n` : readText(path),
      ),
    /Frozen execution input changed/,
  );
  assert.throws(
    () =>
      loadReviewedChallenge((path) =>
        path === 'src/v2/config/repository-belief.estimation-v1.json'
          ? `${readText(path)}\n`
          : readText(path),
      ),
    /Frozen execution input changed/,
  );
});

test('challenge dry-run makes no model calls and rejects unknown CLI flags', async () => {
  await runChallenge(['--dry-run']);
  await assert.rejects(runChallenge(['--unknown']), /Use --challenge/);
});
