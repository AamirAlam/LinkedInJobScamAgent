import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { repositoryEventSchema } from '../repository-replay.ts';
import type { z } from 'zod';
import type { Action } from '../decision-cost.ts';

// These are local authored test fixtures, not untrusted agent inputs. Production
// replay still validates every event and strips scoring metadata independently.
export type FixtureEvent = z.infer<typeof repositoryEventSchema> & {
  reviewed_annotations?: { code_execution_request: string };
};
export type TestFixture = {
  assessment_artifact: string;
  cases: Array<{
    evaluation_id: number;
    assessment_artifact?: string;
    events: FixtureEvent[];
    evaluator_only: {
      ground_truth: 'scam' | 'legitimate' | 'unknown';
      runner_scope?: string;
      review_status?: string;
      checkpoints: Array<{ after_event: string; expected_action: Action }>;
    };
  }>;
};

/** Load a repository fixture; tests deliberately create invalid variants separately. */
export function loadFixture(name = 'synthetic-repository-pair.json'): TestFixture {
  return JSON.parse(
    readFileSync(resolve(__dirname, '../../../data/synthesis', name), 'utf8'),
  ) as TestFixture;
}

/** Collect sequential outputs without sharing a mutable accumulator. */
export async function collectSteps<T>(steps: AsyncIterable<T>): Promise<T[]> {
  let collected: T[] = [];
  for await (const step of steps) {
    collected = [...collected, step];
  }
  return collected;
}
