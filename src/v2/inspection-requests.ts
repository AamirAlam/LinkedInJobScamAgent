import { posix } from 'node:path';
import { z } from 'zod';
import { validateSourcePath } from './repository-source.ts';

export const fileRequestSchema = z.object({
  file: z.string().min(1),
  purpose: z.enum([
    'execution',
    'configuration',
    'local_import',
    'third_party_verification',
    'setup_documentation',
  ]),
  reason: z.string().trim().min(1),
  source_file: z.string().nullable(),
  source_quote: z.string().nullable(),
});
export const requestDecisionSchema = z.object({
  file: z.string(),
  status: z.enum(['accepted', 'outside_scope', 'unsupported_request']),
  reason: z.string(),
});
type SourceText = { file: string; text: string };
type FileRequest = z.infer<typeof fileRequestSchema>;
export type RequestDecision = z.infer<typeof requestDecisionSchema>;

function hasSourceReference(request: FileRequest, files: readonly SourceText[]): boolean {
  const source = files.find((file) => file.file === request.source_file);
  const quote = request.source_quote;
  // Source evidence must come from executable/configuration text, not a README
  // describing optional setup. This checks references, not whether code is safe.
  if (
    !source ||
    /\.(md|txt)$/i.test(source.file) ||
    !quote?.trim() ||
    !source.text.includes(quote)
  ) {
    return false;
  }
  const hookPath = posix.dirname(request.file);
  if (
    ['post-checkout', 'pre-commit', 'post-merge'].includes(posix.basename(request.file)) &&
    quote.includes('core.hooksPath') &&
    quote.includes(hookPath)
  ) {
    return true;
  }
  const basename = posix.basename(request.file);
  const stem = basename.replace(/\.[^.]+$/, '');
  return (
    quote.includes(request.file) ||
    quote.includes(basename) ||
    (stem.length > 2 && quote.includes(stem))
  );
}

function isKnownConfiguration(path: string, availableFiles: readonly string[]): boolean {
  return (
    availableFiles.includes(path) &&
    /^(?:next|vite|webpack|postcss|tailwind)\.config\.[cm]?[jt]s$|^tsconfig(?:\.[\w-]+)?\.json$|^Dockerfile$/.test(
      path,
    )
  );
}

function isNextEntry(
  path: string,
  files: readonly SourceText[],
  availableFiles: readonly string[],
): boolean {
  if (
    !availableFiles.includes(path) ||
    !/^(?:src\/)?app\/(?:[^/]+\/)*(?:page|layout|route|error|loading|not-found|template|default)\.[jt]sx?$/.test(
      path,
    )
  ) {
    return false;
  }
  const manifest = files.find((file) => file.file === 'package.json');
  if (!manifest) {
    return false;
  }
  try {
    const parsed = z
      .object({ scripts: z.record(z.string(), z.string()) })
      .parse(JSON.parse(manifest.text));
    return Object.values(parsed.scripts).some((command) =>
      /\bnext\s+(?:dev|start|build)\b/.test(command),
    );
  } catch {
    return false;
  }
}

function decideRequest(
  request: FileRequest,
  files: readonly SourceText[],
  availableFiles: readonly string[],
): RequestDecision {
  const referenced = hasSourceReference(request, files);
  const optionalMetadata =
    /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|\.env(?:\.[\w-]+)*\.(?:example|sample))$/.test(
      request.file,
    );
  if (
    !referenced &&
    (optionalMetadata ||
      (request.purpose === 'third_party_verification' &&
        request.file.startsWith('node_modules/')) ||
      (request.purpose === 'setup_documentation' && /\.(md|txt)$/i.test(request.file)))
  ) {
    return {
      file: request.file,
      status: 'outside_scope',
      reason:
        'No repository-controlled execution reference; optional setup or third-party verification is outside scope.',
    };
  }
  try {
    validateSourcePath(request.file);
  } catch {
    return {
      file: request.file,
      status: 'unsupported_request',
      reason: 'Path is excluded by source-access restrictions.',
    };
  }
  if (
    !referenced &&
    !files.some((file) => file.file === request.file) &&
    !isNextEntry(request.file, files, availableFiles) &&
    !(request.purpose === 'configuration' && isKnownConfiguration(request.file, availableFiles))
  ) {
    return {
      file: request.file,
      status: 'unsupported_request',
      reason:
        'Provide an exact supplied source quote referencing this path, or a listed supported configuration path.',
    };
  }
  return { file: request.file, status: 'accepted', reason: request.reason };
}

export function executionPriority(path: string): number {
  if (
    /(?:^|\/)(?:hooks|githooks|scripts|\.vscode|\.devcontainer)(?:\/|$)|(?:^|\/)Dockerfile$/.test(
      path,
    )
  ) {
    return 0;
  }
  if (/\.config\.|(?:^|\/)(?:lib|server|api|middleware)(?:\/|\.)|tsconfig/.test(path)) {
    return 1;
  }
  return 2;
}

/** Validate supplemental requests and order accepted files without increasing read budgets. */
export function selectInspectionRequests(
  requests: readonly FileRequest[],
  files: readonly SourceText[],
  availableFiles: readonly string[] = [],
) {
  const decisions = requests.map((request) => decideRequest(request, files, availableFiles));
  const requestedFiles = [
    ...new Set(
      decisions
        .filter(
          (item) => item.status === 'accepted' && !files.some((file) => file.file === item.file),
        )
        .map((item) => item.file),
    ),
  ].toSorted((left, right) => executionPriority(left) - executionPriority(right));
  return { requestedFiles, decisions };
}
