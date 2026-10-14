import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { writeReport } from '../report.ts';

test('exclusive report creation preserves an existing run and snapshots do not mutate input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'v2-report-'));
  const path = join(directory, 'report.json');
  const original = Object.freeze({ status: 'running', steps: Object.freeze(['HOLD']) });
  try {
    writeReport(path, original, true);
    assert.throws(() => writeReport(path, { status: 'replacement' }, true), /EEXIST/);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), original);

    const completed = { ...original, status: 'complete', steps: [...original.steps, 'FLAG'] };
    writeReport(path, completed);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), completed);
    assert.deepEqual(original.steps, ['HOLD']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('error reporting redacts both credentials and handles non-Error exceptions', () => {
  // A child process keeps synthetic credentials separate from the developer's environment.
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `
    const assert = require('node:assert/strict');
    const { describeFailure } = require('./src/v2/report.ts');
    const failure = describeFailure(new Error('openai-test-secret github-test-secret'));
    assert.equal(failure.message, '[REDACTED] [REDACTED]');
    assert.equal(describeFailure(null).message, 'Unknown failure.');
  `,
    ],
    {
      cwd: join(__dirname, '../../..'),
      env: {
        ...process.env,
        OPENAI_API_KEY: 'openai-test-secret',
        V2_GITHUB_TOKEN: 'github-test-secret',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
});
