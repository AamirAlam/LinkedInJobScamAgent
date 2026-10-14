import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRepositoryInspection } from '../repository-inspection-cycle.ts';
import { parseRepositoryUrl, openRemoteRepository, SourceError } from '../repository-source.ts';
import { repositoryEventSchema } from '../repository-replay.ts';
import type { InspectionInput, Review } from '../repository-inspector.ts';

const commit = 'a'.repeat(40),
  tree = 'b'.repeat(40),
  blob = 'c'.repeat(40);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function github(source: string, status = 200): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    assert.ok(path.startsWith('https://api.github.com/repos/example/demo/'));
    assert.equal(init?.redirect, 'error');
    if (path.endsWith('/commits/HEAD')) {
      return json({ sha: commit, commit: { tree: { sha: tree } } }, status);
    }
    if (path.includes('/git/trees/')) {
      return json({
        truncated: false,
        tree: [
          {
            path: 'package.json',
            mode: '100644',
            type: 'blob',
            sha: blob,
            size: Buffer.byteLength(source),
          },
        ],
      });
    }
    if (path.endsWith(`/git/blobs/${blob}`)) {
      return json({
        encoding: 'base64',
        size: Buffer.byteLength(source),
        content: Buffer.from(source).toString('base64'),
      });
    }
    throw new Error('Unexpected URL: ' + path);
  }) as typeof fetch;
}
const clean = async (): Promise<Review> => ({
  coverage_complete: true,
  requested_files: [],
  findings: [],
  gaps: [],
});

test('GitHub cycle pins source and produces scoped clean while retaining authorisation HOLD', async () => {
  const result = await runRepositoryInspection('https://github.com/example/demo.git', 'npm start', {
    fetcher: github('{"scripts":{"start":"echo hello"}}'),
    review: clean,
  });
  assert.equal(result.inspection.outcome, 'no_harmful_behaviour_found');
  assert.equal(result.inspection.scope.artifact_revision, commit);
  assert.equal(result.recommendation.action, 'HOLD');
  assert.equal(result.manual_review.candidate, false);
  repositoryEventSchema.parse({
    event_id: 'e2',
    kind: 'check_result',
    check_id: 'repository_inspection',
    requested_after_event: 'e1',
    agent_input: result.inspection,
  });
});

test('harmful evidence survives a later reviewer omission and yields FLAG', async () => {
  let calls = 0;
  const source = '// inert fixture representing credential theft';
  const review = async (input: InspectionInput): Promise<Review> =>
    ++calls === 1
      ? {
          coverage_complete: false,
          requested_files: ['missing.js'],
          gaps: [],
          findings: [
            {
              file: 'package.json',
              start_line: 1,
              end_line: 1,
              quote: input.files[0].text,
              harmful: true,
              behaviour: 'Synthetic theft evidence.',
            },
          ],
        }
      : { coverage_complete: true, requested_files: [], findings: [], gaps: [] };
  const result = await runRepositoryInspection('https://github.com/example/demo', 'npm start', {
    fetcher: github(source),
    review,
  });
  assert.equal(result.inspection.outcome, 'harmful_behaviour_found');
  assert.equal(result.recommendation.action, 'FLAG');
  assert.equal(result.inspection.scope.findings.length, 1);
});

test('provider errors, uninspected dependencies and missing referenced files remain unresolved', async () => {
  for (const status of [404, 403, 429]) {
    const result = await runRepositoryInspection('https://github.com/example/demo', 'npm start', {
      fetcher: github('{}', status),
      review: async () => {
        throw new Error('Must not call reviewer');
      },
    });
    assert.equal(result.recommendation.action, 'HOLD');
    assert.equal(result.inspection.model_calls, 0);
  }
  const deps = await runRepositoryInspection('https://github.com/example/demo', 'npm install', {
    fetcher: github('{"dependencies":{"example":"1.0.0"}}'),
    review: clean,
  });
  assert.equal(deps.inspection.outcome, 'unresolved');
  let calls = 0;
  const missing = await runRepositoryInspection('https://github.com/example/demo', 'npm start', {
    fetcher: github('{}'),
    review: async () => ({
      ...(await clean()),
      requested_files: ++calls === 1 ? ['missing.js'] : [],
    }),
  });
  assert.equal(missing.inspection.outcome, 'unresolved');
});

test('Bitbucket pins branch commit and reads metadata before raw source', async () => {
  let urls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const path = String(url);
    urls = [...urls, path];
    assert.ok(path.startsWith('https://api.bitbucket.org/2.0/repositories/example/demo'));
    if (path.endsWith('/demo')) {
      return json({ mainbranch: { name: 'main' } });
    }
    if (path.endsWith('/refs/branches/main')) {
      return json({ target: { hash: commit } });
    }
    if (path.endsWith('/package.json?format=meta')) {
      return json({
        type: 'commit_file',
        path: 'package.json',
        size: 2,
        attributes: [],
        commit: { hash: commit },
      });
    }
    if (path.endsWith('/package.json')) {
      return new Response('{}');
    }
    return json({}, 404);
  }) as typeof fetch;
  const result = await runRepositoryInspection('https://bitbucket.org/example/demo', 'npm start', {
    fetcher,
    review: clean,
  });
  assert.equal(result.inspection.outcome, 'no_harmful_behaviour_found');
  assert.ok(
    urls.filter((url) => url.includes('/src/')).every((url) => url.includes(`/src/${commit}/`)),
  );
});

test('rejects unsupported URLs and refuses symlinks without fetching their payload', async () => {
  for (const url of [
    'http://github.com/a/b',
    'https://github.com.evil.test/a/b',
    'https://user:secret@github.com/a/b',
    'https://127.0.0.1/a/b',
    'https://github.com/a/b/tree/main',
    'https://github.com/a/b?ref=main',
  ]) {
    assert.throws(() => parseRepositoryUrl(url));
  }
  const fetcher = (async (url: string | URL | Request) =>
    String(url).endsWith('/commits/HEAD')
      ? json({ sha: commit, commit: { tree: { sha: tree } } })
      : json({
          truncated: false,
          tree: [{ path: 'package.json', mode: '120000', type: 'blob', sha: blob, size: 3 }],
        })) as typeof fetch;
  const repo = await openRemoteRepository('https://github.com/example/demo', fetcher);
  await assert.rejects(repo.readFile('package.json'), /not_regular/);
  await assert.rejects(repo.readFile('../secret'), /invalid_path/);
});

test('rate limits preserve reset time and suppress further fetches within the same source', async () => {
  let calls = 0;
  const fetcher = (async (url: string | URL | Request) => {
    calls++;
    if (String(url).endsWith('/commits/HEAD')) {
      return json({ sha: commit, commit: { tree: { sha: tree } } });
    }
    if (String(url).includes('/git/trees/')) {
      return json({
        truncated: false,
        tree: [{ path: 'package.json', mode: '100644', type: 'blob', sha: blob, size: 2 }],
      });
    }
    return new Response('', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791985671' },
    });
  }) as typeof fetch;
  const source = await openRemoteRepository('https://github.com/example/demo', fetcher);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      source.readFile('package.json'),
      (error: unknown) =>
        error instanceof SourceError &&
        error.code === 'provider_rate_limited' &&
        error.retryAt === '2026-10-14T13:47:51.000Z',
    );
  }
  assert.equal(calls, 3);
  const result = await runRepositoryInspection('https://github.com/example/demo', 'npm start', {
    fetcher: (async () =>
      new Response('', { status: 429, headers: { 'retry-after': 'invalid' } })) as typeof fetch,
    review: clean,
  });
  assert.equal(result.inspection.source_errors[0].code, 'provider_rate_limited');
  assert.equal(result.inspection.source_errors[0].retry_at, null);
  assert.equal(result.recommendation.action, 'HOLD');
  assert.equal(result.inspection.model_calls, 0);
});

test('optional GitHub token is host-scoped, redirects refused, private repositories excluded', async () => {
  const fake = 'test_token_not_a_secret';
  let calls = 0;
  const githubFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(new URL(String(url)).origin, 'https://api.github.com');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${fake}`);
    assert.equal(init?.redirect, 'error');
    return json({ private: true });
  }) as typeof fetch;
  await assert.rejects(
    openRemoteRepository('https://github.com/example/private', githubFetch, fake),
    /private_repository_not_supported/,
  );
  assert.equal(calls, 1);
  const result = await runRepositoryInspection('https://github.com/example/demo', 'npm start', {
    fetcher: (async () => new Response('', { status: 401 })) as typeof fetch,
    review: clean,
  });
  assert.equal(result.recommendation.action, 'HOLD');
  const bitbucketFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return json({}, 404);
  }) as typeof fetch;
  await assert.rejects(
    openRemoteRepository('https://bitbucket.org/example/demo', bitbucketFetch, fake),
    /not_found/,
  );
  await assert.rejects(
    openRemoteRepository('https://github.com/example/demo', githubFetch, 'bad\nheader'),
    /invalid_github_token_format/,
  );
  assert.equal(calls, 1);
});
