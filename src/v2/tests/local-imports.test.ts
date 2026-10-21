import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverLocalImports } from '../local-imports.ts';
import { inspectSource } from '../repository-inspector.ts';
import { prepareManualReview } from '../manual-review.ts';
import { SourceError } from '../repository-source.ts';

test('literal import collection resolves explicit aliases and relative paths without fetching packages or excluded paths', () => {
  const files = [
    {
      file: 'tsconfig.json',
      text: JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
    },
    {
      file: 'app/page.tsx',
      text: `import View from '@/components/View'; import '../lib/api'; require('external'); import(variable); import '../../outside'; import '../.env';`,
    },
  ];
  const available = ['components/View.tsx', 'lib/api.ts', 'external.js', '../outside.ts', '.env'];
  assert.deepEqual(discoverLocalImports(files, available), ['components/View.tsx', 'lib/api.ts']);
  assert.deepEqual(discoverLocalImports(files.slice(1), available), ['lib/api.ts']);
});

test('inspection batches transitive imports before the next model call', async () => {
  const sources: Record<string, string> = {
    'package.json': '{"scripts":{"dev":"next dev"}}',
    'tsconfig.json': '{"compilerOptions":{"paths":{"@/*":["./*"]}}}',
    'app/page.tsx': 'import View from "@/components/View"; import "./Other";',
    'app/Other.tsx': 'export const other = 1;',
    'components/View.tsx': 'import "../lib/api";',
    'lib/api.ts': 'export const value = 1;',
  };
  const result = await inspectSource(
    {
      artifact: 'fixture',
      revision: 'fixed',
      availableFiles: Object.keys(sources),
      readFile: async (path) => {
        if (!(path in sources)) {
          throw new SourceError('not_found');
        }
        return sources[path];
      },
    },
    'npm run dev',
    async (input) => {
      if (!input.files.some((file) => file.file === 'app/page.tsx')) {
        return {
          coverage_complete: false,
          requested_files: ['app/page.tsx'],
          request_decisions: [
            { file: 'lib/api.ts', status: 'unsupported_request', reason: 'Not yet referenced.' },
          ],
          gaps: [],
          findings: [],
        };
      }
      assert.ok(input.files.some((file) => file.file === 'lib/api.ts'));
      assert.ok(
        input.files.findIndex((file) => file.file === 'lib/api.ts') <
          input.files.findIndex((file) => file.file === 'app/Other.tsx'),
      );
      return { coverage_complete: true, requested_files: [], gaps: [], findings: [] };
    },
  );
  assert.equal(result.model_calls, 2);
  assert.equal(result.outcome, 'no_harmful_behaviour_found');
});

test('automatic import traversal stops at the existing file budget and cannot clear missing coverage', async () => {
  const sources = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [`file${index}.ts`, `import "./file${index + 1}";`]),
  );
  const result = await inspectSource(
    {
      artifact: 'fixture',
      revision: 'fixed',
      availableFiles: Object.keys(sources),
      readFile: async (path) => {
        if (path === 'package.json') {
          return '{}';
        }
        if (!(path in sources)) {
          throw new SourceError('not_found');
        }
        return sources[path];
      },
    },
    'npm run dev',
    async (input) => {
      const hasEntry = input.files.some((file) => file.file === 'file0.ts');
      if (hasEntry) {
        assert.equal(input.collection_budget?.remaining_paths, 0);
        assert.ok((input.collection_budget?.remaining_bytes ?? 0) > 0);
      }
      return {
        coverage_complete: hasEntry,
        requested_files: hasEntry ? ['file29.ts'] : ['file0.ts'],
        request_decisions: [
          { file: 'file18.ts', status: 'unsupported_request', reason: 'Not yet referenced.' },
        ],
        findings: [],
        gaps: [],
      };
    },
  );
  assert.equal(result.outcome, 'unresolved');
  assert.ok(result.scope.inspected_files.length <= 24);
  assert.ok(result.scope.gaps.some((gap) => gap.includes('File-count budget')));
  assert.ok(!result.scope.inspected_files.includes('file29.ts'));
  assert.equal(result.model_calls, 2);
  assert.ok(result.scope.gaps.some((gap) => gap.includes('Collection budget exhausted')));
  assert.ok(result.scope.gaps.includes('Uninspected local path: file29.ts.'));
  assert.ok(result.scope.gaps.includes('Uninspected local path: file18.ts.'));
  assert.ok(
    !result.scope.gaps.some((gap) => gap.startsWith('Unjustified') && gap.includes('file18.ts')),
  );
  const discoveredUnread = result.scope.gaps.filter((gap) =>
    gap.startsWith('Uninspected local path:'),
  );
  assert.ok(discoveredUnread.length >= 2); // Includes the next known import, not just the model request.
  const handoff = prepareManualReview(
    JSON.stringify({
      purpose: 'live_read_only_repository_inspection',
      inspection: result,
    }),
    'fixture-report.json',
  );
  assert.equal(handoff.status, 'pending_human_review');
  assert.deepEqual(
    handoff.gap_reviews.map((item) => item.gap),
    result.scope.gaps,
  );
  assert.ok(
    handoff.gap_reviews.every((item) => item.status === 'pending' && item.evidence.length === 0),
  );
});
