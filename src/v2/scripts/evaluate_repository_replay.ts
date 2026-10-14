// Preserve the existing evaluation command; V2 startup lives in agent-v2.ts.
import { main } from '../agent-v2.ts';

main().catch(error => {
    console.error(error instanceof Error ? error.message : 'V2 evaluation failed.');
    process.exitCode = 1;
});
