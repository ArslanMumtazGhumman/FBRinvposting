/** Worker process: `node dist/worker.js` (same image and env as the API). Posts invoices and refreshes reference data. */
import { config } from './config.js';
import { assertRlsEnforced, closeDb } from './db/client.js';
import { startReferenceWorker } from './queue/reference.js';
import { startPostWorker } from './queue/worker.js';

await assertRlsEnforced();
const posting = startPostWorker();
const reference = await startReferenceWorker();
console.log(`rasid-worker posting with concurrency ${config.postWorkerConcurrency} (${config.postConcurrencyPerBusiness} per business); reference refresh at "${config.referenceRefreshCron}" Asia/Karachi`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  // Lets in-flight posts finish and record their outcome before exiting.
  process.once(signal, () => void Promise.all([posting.close(), reference.close()]).then(closeDb).finally(() => process.exit(0)));
}
