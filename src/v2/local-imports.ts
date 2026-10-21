import { posix } from 'node:path';
import { z } from 'zod';
import { validateSourcePath } from './repository-source.ts';

type SourceText = { file: string; text: string };
const configSchema = z.object({
  compilerOptions: z.object({
    baseUrl: z.string().optional(),
    paths: z.record(z.string(), z.array(z.string())).optional(),
  }),
});

function importTargets(specifier: string, source: string, files: readonly SourceText[]): string[] {
  if (specifier.startsWith('.')) {
    return [posix.join(posix.dirname(source), specifier)];
  }
  const config = files.find((file) => file.file === 'tsconfig.json');
  if (!config) {
    return [];
  }
  try {
    const { compilerOptions } = configSchema.parse(JSON.parse(config.text));
    return Object.entries(compilerOptions.paths ?? {}).flatMap(([pattern, targets]) => {
      const [prefix, suffix = ''] = pattern.split('*');
      if (pattern.includes('*')) {
        if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
          return [];
        }
        const capture = specifier.slice(prefix.length, suffix ? -suffix.length : undefined);
        return targets.map((target) =>
          posix.join(compilerOptions.baseUrl ?? '.', target.replace('*', capture)),
        );
      }
      return pattern === specifier
        ? targets.map((target) => posix.join(compilerOptions.baseUrl ?? '.', target))
        : [];
    });
  } catch {
    return [];
  }
}

/** Discover listed literal local imports; this is collection assistance, never proof of coverage. */
export function discoverLocalImports(
  files: readonly SourceText[],
  availableFiles: readonly string[],
): string[] {
  // ponytail: bounded literal matching, not a JS resolver. Dynamic targets, JSONC/extended
  // configurations and unlisted paths remain the model reviewer's responsibility.
  const imports = files
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file.file))
    .flatMap((file) =>
      [
        ...file.text.matchAll(
          /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g,
        ),
      ].flatMap((match) => importTargets(match[1], file.file, files)),
    );
  return [
    ...new Set(
      imports.flatMap((target) => {
        const candidates = [
          target,
          ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'].map(
            (extension) => target + extension,
          ),
          ...['.ts', '.tsx', '.js', '.jsx'].map((extension) =>
            posix.join(target, 'index' + extension),
          ),
        ];
        return candidates.filter((path) => {
          try {
            validateSourcePath(path);
            return availableFiles.includes(path) && !files.some((file) => file.file === path);
          } catch {
            return false;
          }
        });
      }),
    ),
  ];
}
