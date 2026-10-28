// Preserve the existing evaluation command; V2 startup lives in agent-v2.ts.
import { main } from '../agent-v2.ts';
import { runChallenge } from './evaluate_repository_challenge.ts';
import { runDirectBaseline } from './evaluate_direct_baseline.ts';

const args = process.argv.slice(2);
const run =
  args[0] === '--challenge'
    ? () => runChallenge(args.slice(1))
    : args[0] === '--challenge-baseline'
      ? () => runDirectBaseline(args.slice(1))
      : main;
run().catch((error) => {
  console.error(error instanceof Error ? error.message : 'V2 evaluation failed.');
  // eslint-disable-next-line no-restricted-syntax -- CLI exit status is an intentional process side effect.
  process.exitCode = 1;
});
