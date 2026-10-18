import { createApp } from './app.js';
import { config } from './config.js';
import { assertRlsEnforced, closeDb } from './db/client.js';
import { closeQueue } from './queue/posting.js';

await assertRlsEnforced();
const server = createApp().listen(config.port, () => console.log(`rasid-api listening on :${config.port}`));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => server.close(() => void closeQueue().then(closeDb).finally(() => process.exit(0))));
}
