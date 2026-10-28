import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fitEstimationBelief } from '../fit-belief-model.ts';
import { writeReport } from '../report.ts';

/** Save an exclusive research model and count audit; no agent or model API is called. */
export function main() {
  const [sourceFile, partitionFile, outputFile, ...extra] = process.argv.slice(2);
  if (!sourceFile || !partitionFile || !outputFile || extra.length) {
    throw new Error(
      'Pass SOURCE.json PARTITION.json MODEL.json. A MODEL.json.fit.json audit is also written.',
    );
  }
  const auditFile = `${outputFile}.fit.json`;
  if (existsSync(outputFile) || existsSync(auditFile)) {
    throw new Error('Model or audit already exists; existing outputs are never overwritten.');
  }
  const fitted = fitEstimationBelief(
    readFileSync(sourceFile, 'utf8'),
    sourceFile,
    readFileSync(partitionFile, 'utf8'),
  );
  mkdirSync(dirname(outputFile), { recursive: true });
  writeReport(outputFile, fitted.model, true);
  writeReport(auditFile, fitted.audit, true);
  console.log(`Saved estimation-only synthetic model: ${outputFile}. Audit: ${auditFile}.`);
  console.log(
    `Zero likelihood in both groups: ${fitted.audit.zero_in_both_groups.join(', ') || 'none'}. No smoothing applied.`,
  );
}

if (require.main === module) {
  main();
}
