import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRepository } from '../repository-inspector.ts';

test('read-only inspection follows local references, refuses escapes, and preserves proposed evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v2-inspection-'));
  try {
    await writeFile(join(root, 'package.json'), '{"scripts":{"start":"node scripts/start.js"}}');
    await mkdir(join(root, 'scripts'));
    await writeFile(join(root, 'scripts/start.js'), '// inert synthetic credential-theft finding');
    await symlink(join(root, 'package.json'), join(root, 'alias.json'));
    let calls = 0;
    const result = await inspectRepository(root, 'npm start', async (input) => {
      calls++;
      if (calls === 1) {
        return {
          coverage_complete: true,
          requested_files: ['scripts/start.js', '../outside', '/etc/passwd', 'alias.json'],
          findings: [],
          gaps: [],
        };
      }
      assert.deepEqual(
        input.files.map((file) => file.file),
        ['package.json', 'scripts/start.js'],
      );
      assert.ok(input.unavailable.includes('../outside'));
      assert.ok(input.unavailable.includes('/etc/passwd'));
      assert.ok(input.unavailable.includes('alias.json'));
      return {
        coverage_complete: true,
        requested_files: [],
        gaps: [],
        findings: [
          {
            file: 'scripts/start.js',
            start_line: 1,
            end_line: 1,
            quote: '// inert synthetic credential-theft finding',
            behaviour: 'Synthetic test finding.',
            harmful: true,
          },
        ],
      };
    });
    assert.equal(calls, 2);
    assert.equal(result.outcome, 'harmful_behaviour_found');
    assert.equal(result.scope.findings.length, 1);
    assert.equal(result.file_hashes.length, 2);
    const invalid = await inspectRepository(root, 'npm start', async () => ({
      coverage_complete: true,
      requested_files: [],
      gaps: [],
      findings: [
        {
          file: 'package.json',
          start_line: 1,
          end_line: 1,
          quote: 'invented',
          behaviour: 'bad',
          harmful: true,
        },
      ],
    }));
    assert.equal(invalid.outcome, 'unresolved');
    assert.ok(invalid.scope.gaps.some((gap) => gap.includes('invalid evidence')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('oversized files and exhausted review budget stay unresolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'v2-inspection-'));
  try {
    await writeFile(join(root, 'README.md'), 'x'.repeat(32769));
    await writeFile(join(root, 'package.json'), '{}');
    let calls = 0;
    const result = await inspectRepository(root, 'npm start', async (input) => {
      assert.ok(input.unavailable.includes('README.md'));
      return {
        coverage_complete: true,
        requested_files: [`missing-${++calls}.js`],
        findings: [],
        gaps: [],
      };
    });
    assert.equal(calls, 4);
    assert.ok(result.scope.gaps.some((gap) => gap.includes('budget')));
    assert.equal(result.outcome, 'unresolved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid citations are recorded and corrected while referenced hook inspection proceeds', async () => {
  const { inspectSource } = await import('../repository-inspector.ts');
  const { SourceError } = await import('../repository-source.ts');
  const task = '{"command":"git config core.hooksPath hooks; git checkout main"}';
  const hook = '# inert fixture for a remote execution finding';
  const contents: Record<string, string> = {
    '.vscode/tasks.json': task,
    'hooks/post-checkout': hook,
  };
  let calls = 0;
  const report = await inspectSource(
    {
      artifact: 'synthetic',
      revision: 'fixture',
      async readFile(path) {
        if (!(path in contents)) {
          throw new SourceError('not_found');
        }
        return contents[path];
      },
    },
    'npm run dev',
    async (input) => {
      calls++;
      if (calls === 1) {
        return {
          coverage_complete: false,
          requested_files: ['hooks/post-checkout'],
          gaps: [],
          findings: [
            {
              file: '.vscode/tasks.json',
              start_line: 2,
              end_line: 2,
              quote: 'invented task text',
              harmful: false,
              behaviour: 'Activates a hook.',
            },
          ],
        };
      }
      assert.equal(input.correction?.code, 'invalid_evidence_citation');
      assert.ok(input.files.some((file) => file.file === 'hooks/post-checkout'));
      assert.equal(
        input.files.find((file) => file.file === '.vscode/tasks.json')?.numbered_text,
        '1: ' + task,
      );
      return {
        coverage_complete: false,
        requested_files: [],
        gaps: ['External payload not inspected.'],
        findings: [
          {
            file: 'hooks/post-checkout',
            start_line: 1,
            end_line: 1,
            quote: hook,
            harmful: true,
            behaviour: 'Synthetic harmful execution finding.',
          },
        ],
      };
    },
  );
  assert.equal(calls, 2);
  assert.equal(report.outcome, 'harmful_behaviour_found');
  assert.equal(report.review_errors.length, 1);
  assert.equal(report.scope.findings.length, 1);
  assert.equal(report.scope.findings[0].file, 'hooks/post-checkout');
});

test('persistent invalid evidence cannot become clean or harmful and stays within four calls', async () => {
  const { inspectSource } = await import('../repository-inspector.ts');
  const { SourceError } = await import('../repository-source.ts');
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
        requested_files: [],
        gaps: [],
        findings: [
          {
            file: 'package.json',
            start_line: 1,
            end_line: 1,
            quote: 'invented harmful code',
            harmful: true,
            behaviour: 'Unsupported claim.',
          },
        ],
      };
    },
  );
  assert.equal(calls, 4);
  assert.equal(result.outcome, 'unresolved');
  assert.equal(result.scope.findings.length, 0);
  assert.equal(result.review_errors.length, 4);
});

test('citations derive exact source lines, tolerate outer indentation, and reject ambiguous quotes', async () => {
  const { inspectSource } = await import('../repository-inspector.ts');
  const { SourceError } = await import('../repository-source.ts');
  const text = '// header\n    const specific = 123;\nrepeat\nrepeat';
  const source = {
    artifact: 'synthetic',
    revision: 'fixture',
    async readFile(path: string) {
      if (path !== 'package.json') {
        throw new SourceError('not_found');
      }
      return text;
    },
  };
  const fixed = await inspectSource(source, 'read source', async () => ({
    coverage_complete: true,
    requested_files: [],
    gaps: [],
    findings: [
      {
        file: 'package.json',
        start_line: 99,
        end_line: 100,
        quote: 'const specific = 123;',
        behaviour: 'An ordinary constant.',
        harmful: false,
      },
    ],
  }));
  assert.equal(fixed.scope.findings[0].start_line, 2);
  assert.equal(fixed.scope.findings[0].end_line, 2);
  assert.equal(fixed.scope.findings[0].quote, '    const specific = 123;');
  assert.equal(fixed.citation_adjustments.length, 1);
  assert.equal(fixed.outcome, 'no_harmful_behaviour_found');
  const ambiguous = await inspectSource(source, 'read source', async () => ({
    coverage_complete: true,
    requested_files: [],
    gaps: [],
    findings: [
      {
        file: 'package.json',
        start_line: 3,
        end_line: 3,
        quote: 'repeat',
        behaviour: 'Ambiguous evidence.',
        harmful: true,
      },
    ],
  }));
  assert.equal(ambiguous.outcome, 'unresolved');
  assert.equal(ambiguous.scope.findings.length, 0);
});
