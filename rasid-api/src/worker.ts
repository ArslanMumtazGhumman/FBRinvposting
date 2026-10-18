/** Posting worker process: `node dist/worker.js` (same image and env as the API). */
import { config } from './config.js';
import { assertRlsEnforced, closeDb } from './db/client.js';
import { startPostWorker } from './queue/worker.js';

await assertRlsEnforced();
const { close } = startPostWorker();
console.log(`rasid-worker posting with concurrency ${config.postWorkerConcurrency} (${config.postConcurrencyPerBusiness} per business)`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  // Lets in-flight posts finish and record their outcome before exiting.
  process.once(signal, () => void close().then(closeDb).finally(() => process.exit(0)));
}
