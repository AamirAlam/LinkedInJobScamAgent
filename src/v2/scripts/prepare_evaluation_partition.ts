import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createEvaluationPartition, validateEvaluationPartition } from '../evaluation-partition.ts';
import { writeReport } from '../report.ts';

/** Freeze an exclusive, source-bound development partition without modifying datasets or fitting a model. */
export function main() {
  const [sourceFile, outputFile, ...extra] = process.argv.slice(2);
  if (!sourceFile || !outputFile || extra.length) {
    throw new Error('Pass SOURCE.json OUTPUT.json. Existing outputs are never overwritten.');
  }
  const raw = readFileSync(sourceFile, 'utf8');
  const partition = createEvaluationPartition(raw, sourceFile);
  validateEvaluationPartition(partition, raw, sourceFile);
  mkdirSync(dirname(outputFile), { recursive: true });
  writeReport(outputFile, partition, true);
  for (const [name, summary] of Object.entries(partition.partitions)) {
    console.log(
      `${name}: ${summary.case_ids.length} cases, ${summary.group_ids.length} connected groups; ${summary.repository_runner.supported_case_ids.length} repository-compatible cases.`,
    );
  }
  console.log(`Retrospective development partition only; not held-out. Saved: ${outputFile}`);
}

if (require.main === module) {
  main();
}
