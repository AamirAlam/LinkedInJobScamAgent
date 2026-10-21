import { mkdirSync, writeFileSync } from 'node:fs';

/** Create a new report without overwriting a previous run. */
export function createReport(
  prefix: string,
  report: unknown,
  createdAt = new Date().toISOString(),
): string {
  mkdirSync('results', { recursive: true });
  const path = `results/${prefix}-${createdAt.replace(/[:.]/g, '-')}.json`;
  writeReport(path, report, true);
  return path;
}

/** Persist a snapshot; only the caller's current run may be updated. */
export function writeReport(path: string, report: unknown, exclusive = false): void {
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' });
}

/** Restrict persisted error details and redact configured credentials. */
export function describeFailure(error: unknown) {
  const failure = error instanceof Error ? error : new Error('Unknown failure.');
  const secrets = [process.env.OPENAI_API_KEY, process.env.V2_GITHUB_TOKEN].filter(
    (secret): secret is string => Boolean(secret),
  );
  const message = secrets.reduce(
    (text, secret) => text.replaceAll(secret, '[REDACTED]'),
    failure.message,
  );
  return { name: failure.name, message: message.slice(0, 300) };
}
