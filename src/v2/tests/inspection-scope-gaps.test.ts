import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectSource } from '../repository-inspector.ts';
import { SourceError } from '../repository-source.ts';

const manifest = '{"scripts":{"start":"node scripts/start.js"}}';
const source = {
  artifact: 'fixture',
  revision: 'fixed',
  readFile: async (path: string) => {
    if (path !== 'package.json') {
      throw new SourceError('not_found');
    }
    return manifest;
  },
};
const base = { coverage_complete: true, requested_files: [], findings: [] };

test('excluded gap claims require explicit correction before scoped completion', async () => {
  const description = 'Dependency implementation has not been inspected.';
  const result = await inspectSource(source, 'npm start', async (input) => {
    if (input.correction) {
      assert.equal(input.correction.code, 'invalid_scope_gap');
      assert.deepEqual(input.correction.rejected_gaps, [description]);
      return { ...base, gaps: [], scope_gaps: [] };
    }
    return {
      ...base,
      gaps: [description],
      scope_gaps: [
        {
          description,
          kind: 'third_party_verification',
          source_file: 'package.json',
          source_quote: manifest,
        },
      ],
    };
  });
  assert.equal(result.model_calls, 2);
  assert.equal(result.review_errors[0].code, 'invalid_scope_gap');
  assert.equal(result.outcome, 'no_harmful_behaviour_found');
});

test('a cited missing local execution path remains an in-scope gap', async () => {
  const description = 'scripts/start.js has not been inspected.';
  const result = await inspectSource(source, 'npm start', async () => ({
    ...base,
    coverage_complete: false,
    gaps: [description],
    scope_gaps: [
      {
        description,
        kind: 'missing_repository_file',
        source_file: 'package.json',
        source_quote: manifest,
      },
    ],
  }));
  assert.equal(result.outcome, 'unresolved');
  assert.ok(result.scope.gaps.includes(description));
  assert.equal(result.review_errors.length, 0);
});

test('persistent speculative or fabricated gap claims stay unresolved within the review limit', async () => {
  for (const quote of [null, 'invented source']) {
    const result = await inspectSource(source, 'npm start', async () => ({
      ...base,
      gaps: ['Possible hidden hook.'],
      scope_gaps: [
        {
          description: 'Possible hidden hook.',
          kind: 'unresolved_repository_behaviour',
          source_file: 'package.json',
          source_quote: quote,
        },
      ],
    }));
    assert.equal(result.outcome, 'unresolved');
    assert.equal(result.model_calls, 4);
    assert.ok(result.review_errors.every((error) => error.code === 'invalid_scope_gap'));
  }
});

test('scope correction cannot discard independently validated harmful findings', async () => {
  const result = await inspectSource(source, 'npm start', async (input) => ({
    ...base,
    // Inert fixture: verifies retention of an automated finding, not malware semantics.
    findings: input.correction
      ? []
      : [
          {
            file: 'package.json',
            start_line: 1,
            end_line: 1,
            quote: manifest,
            behaviour: 'Synthetic harmful finding.',
            harmful: true,
          },
        ],
    gaps: input.correction ? [] : ['Optional setup missing.'],
    scope_gaps: input.correction
      ? []
      : [
          {
            description: 'Optional setup missing.',
            kind: 'optional_setup',
            source_file: null,
            source_quote: null,
          },
        ],
  }));
  assert.equal(result.outcome, 'harmful_behaviour_found');
  assert.equal(result.scope.findings.length, 1);
  assert.equal(result.model_calls, 2);
});
