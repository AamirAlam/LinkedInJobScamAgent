import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { prepareRepositoryCases } from './agent-v2.ts';
import { parseConversationBeliefConfig } from './conversation-belief.ts';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const checkpointSchema = z
  .object({ after_event: z.string(), expected_action: z.enum(['SAFE', 'HOLD', 'FLAG']) })
  .passthrough();
const sourceSchema = z.object({
  purpose: z.literal('prospective_authored_repository_challenge'),
  origin: z.literal('synthetic'),
  held_out: z.literal(false),
  check_mode: z.literal('scripted_results'),
  artifact_mode: z.literal('placeholder_only_do_not_fetch_or_execute'),
  model_file: z.string().min(1),
  freeze_file: z.string().min(1),
  freeze_sha256: hashSchema,
  execution_snapshot_file: z.string().min(1),
  execution_snapshot_sha256: hashSchema,
  cases: z
    .array(
      z.object({
        evaluation_id: z.number().int(),
        assessment_artifact: z.string().min(1),
        events: z.array(z.unknown()),
        evaluator_only: z.object({
          ground_truth: z.enum(['scam', 'legitimate', 'unknown']),
          runner_scope: z.literal('repository_replay'),
          review_status: z.string(),
          checkpoints: z.array(checkpointSchema).min(1),
        }),
      }),
    )
    .min(1),
});
const reviewSchema = z.object({
  purpose: z.literal('user_review_of_scripted_action_targets'),
  source_file: z.string(),
  source_sha256: hashSchema,
  pending_case_ids: z.array(z.number().int()).length(0),
  reviews: z.array(
    z.object({
      evaluation_id: z.number().int(),
      status: z.literal('accepted_action_targets'),
      accepted_checkpoints: z.array(checkpointSchema),
    }),
  ),
});
const executionSchema = z.object({
  purpose: z.literal('pre_run_execution_protocol_snapshot'),
  original_pre_authoring_snapshot: z.string(),
  original_snapshot_sha256: hashSchema,
  files: z.record(z.string(), hashSchema),
});

export const CHALLENGE_SOURCE = 'data/synthesis/repository-evaluation-v1.json';
export const CHALLENGE_REVIEWS = 'data/synthesis/repository-evaluation-v1.target-reviews.json';

/** Hash exact UTF-8 research artifact bytes; no normalisation is applied. */
export function hashEvaluationText(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

/** Check complete, source-bound action-target acceptance; this does not authenticate fictional findings. */
export function validateChallengeReviews(
  rawSource: string,
  rawReviews: string,
  sourceFile: string,
) {
  const source = sourceSchema.parse(JSON.parse(rawSource));
  const reviews = reviewSchema.parse(JSON.parse(rawReviews));
  if (
    reviews.source_file !== sourceFile ||
    reviews.source_sha256 !== hashEvaluationText(rawSource)
  ) {
    throw new Error('Review overlay does not match the source snapshot.');
  }
  if (
    new Set(reviews.reviews.map((review) => review.evaluation_id)).size !==
      reviews.reviews.length ||
    reviews.reviews.length !== source.cases.length
  ) {
    throw new Error('Each challenge case needs exactly one accepted target review.');
  }
  for (const scenario of source.cases) {
    const review = reviews.reviews.find((item) => item.evaluation_id === scenario.evaluation_id);
    if (
      !review ||
      !isDeepStrictEqual(review.accepted_checkpoints, scenario.evaluator_only.checkpoints)
    ) {
      throw new Error(`Case ${scenario.evaluation_id} target review is missing or stale.`);
    }
  }
  return source;
}

/** Preflight frozen code/model bytes and reviewed targets before any billable annotation calls. */
export function loadReviewedChallenge(
  readText: (path: string) => string = (path) => readFileSync(path, 'utf8'),
) {
  const rawSource = readText(CHALLENGE_SOURCE);
  const rawReviews = readText(CHALLENGE_REVIEWS);
  const source = validateChallengeReviews(rawSource, rawReviews, CHALLENGE_SOURCE);
  const rawFreeze = readText(source.freeze_file);
  const rawExecution = readText(source.execution_snapshot_file);
  if (
    hashEvaluationText(rawFreeze) !== source.freeze_sha256 ||
    hashEvaluationText(rawExecution) !== source.execution_snapshot_sha256
  ) {
    throw new Error('Challenge freeze or execution snapshot has changed.');
  }
  const execution = executionSchema.parse(JSON.parse(rawExecution));
  if (
    execution.original_pre_authoring_snapshot !== source.freeze_file ||
    execution.original_snapshot_sha256 !== source.freeze_sha256
  ) {
    throw new Error('Execution snapshot is not bound to the original authoring snapshot.');
  }
  for (const [path, expected] of Object.entries(execution.files)) {
    if (hashEvaluationText(readText(path)) !== expected) {
      throw new Error(
        `Frozen execution input changed: ${path}. Record a new research version before scoring.`,
      );
    }
  }
  const rawModel = readText(source.model_file);
  if (execution.files[source.model_file] !== hashEvaluationText(rawModel)) {
    throw new Error('Model must be included in the frozen execution inputs.');
  }
  const model = parseConversationBeliefConfig(JSON.parse(rawModel));
  const auditFile = `${source.model_file}.fit.json`;
  const rawAudit = readText(auditFile);
  if (execution.files[auditFile] !== hashEvaluationText(rawAudit)) {
    throw new Error('Estimation audit must be frozen with the model.');
  }
  const audit = z
    .object({
      estimation_case_ids: z.array(z.number().int()),
      smoothing: z.literal('none_no_pseudocounts'),
    })
    .parse(JSON.parse(rawAudit));
  if (source.cases.some((scenario) => audit.estimation_case_ids.includes(scenario.evaluation_id))) {
    throw new Error('Challenge cases overlap model-estimation case IDs.');
  }
  const coverage = prepareRepositoryCases(source, true);
  if (coverage.skipped.length) {
    throw new Error('Reviewed repository challenge must not silently skip cases.');
  }
  return {
    rawSource,
    source,
    coverage,
    model,
    hashes: {
      source: hashEvaluationText(rawSource),
      reviews: hashEvaluationText(rawReviews),
      model: hashEvaluationText(rawModel),
      estimation_audit: hashEvaluationText(rawAudit),
      execution: hashEvaluationText(rawExecution),
    },
  };
}
