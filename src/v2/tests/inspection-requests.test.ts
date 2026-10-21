import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectInspectionRequests } from '../inspection-requests.ts';
import { inspectSource } from '../repository-inspector.ts';
import { SourceError } from '../repository-source.ts';

const sourceText =
  'import "./components/Hero"; import "./lib/github"; git config core.hooksPath .github/githooks';
const files = [{ file: 'entry.ts', text: sourceText }];
const request = (file: string) => ({
  file,
  purpose: 'local_import' as const,
  reason: 'Follow the supplied execution reference.',
  source_file: 'entry.ts',
  source_quote: sourceText,
});

test('requests prioritise referenced hooks and server helpers before presentation imports', () => {
  const selected = selectInspectionRequests(
    [
      request('components/Hero.tsx'),
      request('lib/github.ts'),
      request('.github/githooks/post-checkout'),
      request('lib/github.ts'),
    ],
    files,
  );
  assert.deepEqual(selected.requestedFiles, [
    '.github/githooks/post-checkout',
    'lib/github.ts',
    'components/Hero.tsx',
  ]);
});

test('optional metadata and package audits are excluded, but referenced or unjustified code is not silently cleared', () => {
  const selected = selectInspectionRequests(
    [
      { ...request('package-lock.json'), source_file: null, source_quote: null },
      { ...request('.env.local.example'), source_file: null, source_quote: null },
      { ...request('node_modules/demo/index.js'), purpose: 'third_party_verification' },
      { ...request('scripts/hidden.js'), purpose: 'setup_documentation' },
      { ...request('lib/github.ts'), source_quote: 'invented' },
      request('../secret'),
    ],
    files,
  );
  assert.deepEqual(selected.requestedFiles, []);
  assert.deepEqual(
    selected.decisions.map((item) => item.status),
    [
      'outside_scope',
      'outside_scope',
      'outside_scope',
      'unsupported_request',
      'unsupported_request',
      'unsupported_request',
    ],
  );
  const referencedEnv = selectInspectionRequests(
    [{ ...request('.env.local.example'), source_quote: 'load(".env.local.example")' }],
    [{ file: 'entry.ts', text: 'load(".env.local.example")' }],
  );
  assert.equal(referencedEnv.decisions[0].status, 'unsupported_request'); // Secret-file protection still applies.
  const referencedLock = selectInspectionRequests(
    [{ ...request('package-lock.json'), source_quote: 'read("package-lock.json")' }],
    [{ file: 'entry.ts', text: 'read("package-lock.json")' }],
  );
  assert.equal(referencedLock.decisions[0].status, 'accepted');
});

test('configuration exceptions require an actual listed supported path', () => {
  const config = {
    ...request('next.config.mjs'),
    purpose: 'configuration' as const,
    source_file: null,
    source_quote: null,
  };
  assert.deepEqual(selectInspectionRequests([config], [], ['next.config.mjs']).requestedFiles, [
    'next.config.mjs',
  ]);
  assert.equal(
    selectInspectionRequests([config], [], []).decisions[0].status,
    'unsupported_request',
  );
});

test('out-of-scope requests receive feedback before completion without being read', async () => {
  let calls = 0;
  const result = await inspectSource(
    {
      artifact: 'synthetic',
      revision: 'fixture',
      async readFile(path) {
        assert.notEqual(path, '.env.local.example');
        if (path !== 'package.json') {
          throw new SourceError('not_found');
        }
        return '{}';
      },
    },
    'npm start',
    async (input) => {
      calls++;
      if (calls === 1) {
        return {
          coverage_complete: false,
          findings: [],
          gaps: ['Env example missing.'],
          requested_files: [],
          request_decisions: [
            {
              file: '.env.local.example',
              status: 'outside_scope',
              reason: 'Optional documentation.',
            },
          ],
        };
      }
      assert.equal(input.request_feedback?.[0].status, 'outside_scope');
      return { coverage_complete: true, findings: [], gaps: [], requested_files: [] };
    },
  );
  assert.equal(calls, 2);
  assert.equal(result.outcome, 'no_harmful_behaviour_found');
  assert.equal(result.file_request_decisions.length, 1);
});

test('an unsupported in-scope request remains a blocker when the next review silently omits it', async () => {
  let calls = 0;
  const result = await inspectSource(
    {
      artifact: 'synthetic',
      revision: 'fixture',
      async readFile(path) {
        if (path !== 'package.json') {
          throw new SourceError('not_found');
        }
        return '{}';
      },
    },
    'npm start',
    async () => {
      calls++;
      return {
        coverage_complete: true,
        findings: [],
        gaps: [],
        requested_files: [],
        request_decisions:
          calls === 1
            ? [
                {
                  file: 'scripts/start.js',
                  status: 'unsupported_request',
                  reason: 'Missing source reference.',
                },
              ]
            : [],
      };
    },
  );
  assert.equal(result.outcome, 'unresolved');
  assert.ok(result.scope.gaps.some((gap) => gap.includes('Unjustified in-scope file request')));
});

test('listed Next.js entry points are inspectable by convention only when manifest scripts establish the framework', () => {
  const entries = ['app/page.tsx', 'src/app/account/layout.tsx'];
  const requests = entries.map((file) => ({
    ...request(file),
    source_file: null,
    source_quote: null,
  }));
  const manifest = { file: 'package.json', text: '{"scripts":{"dev":"next dev"}}' };
  assert.deepEqual(selectInspectionRequests(requests, [manifest], entries).requestedFiles, entries);
  assert.deepEqual(selectInspectionRequests(requests, [], entries).requestedFiles, []);
  assert.deepEqual(selectInspectionRequests(requests, [manifest], []).requestedFiles, []);
  const repeated = selectInspectionRequests(
    [{ ...request('package.json'), source_file: null, source_quote: null }],
    [manifest],
  );
  assert.equal(repeated.decisions[0].status, 'accepted');
  assert.deepEqual(repeated.requestedFiles, []);
});
