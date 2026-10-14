// Preserve the existing evaluation command; V2 startup lives in agent-v2.ts.
import { main } from '../agent-v2.ts';

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'V2 evaluation failed.');
  // eslint-disable-next-line no-restricted-syntax -- CLI exit status is an intentional process side effect.
  process.exitCode = 1;
});
