import { z } from 'zod';

export type RepositorySource = {
  readonly artifact: string;
  readonly revision: string;
  readonly availableFiles?: string[];
  readFile(path: string): Promise<string>;
};
export class SourceError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryAt: string | null = null,
  ) {
    super(code);
  }
}
/** Reject paths outside inspectable source, including credentials and repository metadata. */
export function validateSourcePath(path: string): string {
  if (
    !path ||
    path.length > MAX_PATH_LENGTH ||
    // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted source paths.
    /[\\\x00-\x1f:%?#]/.test(path) ||
    path.startsWith('/') ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          ['.git', '.ssh', '.aws', 'node_modules'].includes(part) ||
          /^\.env(?:\.|$)/.test(part),
      )
  ) {
    throw new SourceError('excluded_or_invalid_path');
  }
  return path;
}
/** Accept only supported HTTPS repository root URLs; reject credentials, queries, and subpaths. */
export function parseRepositoryUrl(value: string) {
  const url = new URL(value);
  const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !['github.com', 'bitbucket.org'].includes(url.hostname) ||
    parts.length !== 2 ||
    parts.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || ['.', '..'].includes(part))
  ) {
    throw new SourceError(
      'Use an HTTPS github.com/owner/repo or bitbucket.org/workspace/repo root URL.',
    );
  }
  const [owner, rawRepo] = parts;
  const repo = rawRepo.replace(/\.git$/, '');
  if (!repo || ['.', '..'].includes(repo)) {
    throw new SourceError('invalid_repository');
  }
  return { host: url.hostname, owner, repo, artifact: `https://${url.hostname}/${owner}/${repo}` };
}
const MAX_PATH_LENGTH = 512;
const MAX_JSON_BYTES = 200_000;
const MAX_TREE_BYTES = 2_000_000;
const MAX_BLOB_RESPONSE_BYTES = 60_000;
const MAX_LISTED_FILES = 1_000;
const MAX_SOURCE_BYTES = 32_768;
const MAX_FETCH_REQUESTS = 60;
const FETCH_WINDOW_MS = 120_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_DOWNLOAD_BYTES = 3_000_000;
const MAX_DATE_MS = 8.64e15;
const hash = z.string().regex(/^[a-f0-9]{40,64}$/);

// Public repositories only. Never follow provider-returned URLs, redirects,
// symlinks, submodules, LFS objects or arbitrary hosts. Nothing is written to disk.
/** Open public, revision-pinned source through bounded provider requests without a checkout or execution. */
export async function openRemoteRepository(
  value: string,
  fetcher: typeof fetch = fetch,
  githubToken = process.env.V2_GITHUB_TOKEN,
  requestedRevision?: string,
): Promise<RepositorySource> {
  const repo = parseRepositoryUrl(value);
  if (
    requestedRevision !== undefined &&
    (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(requestedRevision) || repo.host !== 'github.com')
  ) {
    throw new SourceError('Explicit revision requires a full GitHub commit hash.');
  }
  const token = repo.host === 'github.com' ? githubToken?.trim() : undefined;
  if (token && !/^[A-Za-z0-9_]+$/.test(token)) {
    throw new SourceError('invalid_github_token_format');
  }
  const origin =
    repo.host === 'github.com' ? 'https://api.github.com' : 'https://api.bitbucket.org';
  const base =
    repo.host === 'github.com'
      ? `/repos/${repo.owner}/${repo.repo}`
      : `/2.0/repositories/${repo.owner}/${repo.repo}`;
  const { get, json } = createSourceTransport(origin, token, fetcher);
  return repo.host === 'github.com'
    ? openGitHubSource(repo.artifact, base, Boolean(token), json, requestedRevision)
    : openBitbucketSource(repo.artifact, base, get, json);
}

type ReadBytes = (path: string, limit: number) => Promise<Buffer>;
type ReadJson = (path: string, limit?: number) => Promise<unknown>;

function createSourceTransport(origin: string, token: string | undefined, fetcher: typeof fetch) {
  let requests = 0;
  let rateLimit: SourceError | undefined;
  let downloaded = 0;
  const deadline = Date.now() + FETCH_WINDOW_MS;
  async function get(path: string, limit: number): Promise<Buffer> {
    if (rateLimit) {
      throw rateLimit;
    }
    if (++requests > MAX_FETCH_REQUESTS || Date.now() >= deadline) {
      throw new SourceError('fetch_budget_exhausted');
    }
    const response = await fetcher(origin + path, {
      redirect: 'error',
      signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, deadline - Date.now())),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'LinkedInJobScamAgent-read-only',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (
        response.status === 429 ||
        (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
      ) {
        const reset = response.headers.get('x-ratelimit-reset');
        const retry = response.headers.get('retry-after');
        const times = [
          reset && /^\d+$/.test(reset) ? Number(reset) * 1000 : NaN,
          retry
            ? /^\d+$/.test(retry)
              ? Date.now() + Number(retry) * 1000
              : Date.parse(retry)
            : NaN,
        ].filter((time) => Number.isFinite(time) && time >= 0 && time <= MAX_DATE_MS);
        rateLimit = new SourceError(
          'provider_rate_limited',
          times.length ? new Date(Math.max(...times)).toISOString() : null,
        );
        throw rateLimit;
      }
      throw new SourceError(
        response.status === 404 ? 'not_found' : `provider_http_${response.status}`,
      );
    }
    if (!response.body) {
      throw new SourceError('empty_response');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        size += value.length;
        downloaded += value.length;
        if (size > limit || downloaded > MAX_DOWNLOAD_BYTES) {
          throw new SourceError('response_size_budget');
        }
        // Local streaming buffer: avoid copying accumulated chunks on every read.
        // eslint-disable-next-line no-restricted-syntax
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  async function json(path: string, limit = MAX_JSON_BYTES): Promise<unknown> {
    return JSON.parse((await get(path, limit)).toString('utf8'));
  }
  return { get, json };
}

function decodeSource(buffer: Buffer) {
  if (buffer.length > MAX_SOURCE_BYTES) {
    throw new SourceError('file_size_budget');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  if (text.includes('\0') || text.startsWith('version https://git-lfs.github.com/spec/')) {
    throw new SourceError('binary_or_lfs_file');
  }
  return text;
}

async function openGitHubSource(
  artifact: string,
  base: string,
  authenticated: boolean,
  json: ReadJson,
  requestedRevision?: string,
): Promise<RepositorySource> {
  if (authenticated) {
    const metadata = z.object({ private: z.boolean() }).parse(await json(base));
    if (metadata.private) {
      throw new SourceError('private_repository_not_supported');
    }
  }
  const commit = z
    .object({ sha: hash, commit: z.object({ tree: z.object({ sha: hash }) }) })
    .parse(await json(`${base}/commits/${requestedRevision ?? 'HEAD'}`));
  if (requestedRevision && commit.sha !== requestedRevision) {
    throw new SourceError('source_revision_mismatch');
  }
  const tree = z
    .object({
      truncated: z.boolean(),
      tree: z.array(
        z.object({
          path: z.string(),
          mode: z.string(),
          type: z.string(),
          sha: hash,
          size: z.number().optional(),
        }),
      ),
    })
    .parse(await json(`${base}/git/trees/${commit.commit.tree.sha}?recursive=1`, MAX_TREE_BYTES));
  if (tree.truncated) {
    throw new SourceError('repository_tree_truncated');
  }
  const entries = new Map(tree.tree.map((entry) => [entry.path, entry]));
  return {
    artifact,
    revision: commit.sha,
    availableFiles: tree.tree
      .filter((entry) => entry.type === 'blob')
      .map((entry) => entry.path)
      .slice(0, MAX_LISTED_FILES),
    async readFile(path) {
      validateSourcePath(path);
      const entry = entries.get(path);
      if (!entry) {
        throw new SourceError('not_found');
      }
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
        throw new SourceError('not_regular_source_file');
      }
      if (entry.size === undefined || entry.size > MAX_SOURCE_BYTES) {
        throw new SourceError('file_size_budget');
      }
      const blob = z
        .object({ encoding: z.literal('base64'), content: z.string(), size: z.number() })
        .parse(await json(`${base}/git/blobs/${entry.sha}`, MAX_BLOB_RESPONSE_BYTES));
      if (blob.size !== entry.size) {
        throw new SourceError('blob_size_mismatch');
      }
      const bytes = Buffer.from(blob.content, 'base64');
      if (bytes.length !== entry.size) {
        throw new SourceError('blob_size_mismatch');
      }
      return decodeSource(bytes);
    },
  };
}

async function openBitbucketSource(
  artifact: string,
  base: string,
  get: ReadBytes,
  json: ReadJson,
): Promise<RepositorySource> {
  const info = z
    .object({ mainbranch: z.object({ name: z.string().min(1) }) })
    .parse(await json(base));
  const branch = z
    .object({ target: z.object({ hash }) })
    .parse(await json(`${base}/refs/branches/${encodeURIComponent(info.mainbranch.name)}`));
  const revision = branch.target.hash;
  return {
    artifact,
    revision,
    async readFile(path) {
      validateSourcePath(path);
      const resource = `${base}/src/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
      const meta = z
        .object({
          type: z.literal('commit_file'),
          path: z.string(),
          size: z.number(),
          attributes: z.array(z.string()),
          commit: z.object({ hash }),
        })
        .parse(await json(resource + '?format=meta'));
      if (meta.path !== path || meta.commit.hash !== revision) {
        throw new SourceError('source_revision_mismatch');
      }
      if (
        meta.size > MAX_SOURCE_BYTES ||
        meta.attributes.some((attr) => ['link', 'subrepository', 'binary'].includes(attr))
      ) {
        throw new SourceError('unsupported_file');
      }
      return decodeSource(await get(resource, MAX_SOURCE_BYTES));
    },
  };
}
