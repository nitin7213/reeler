import { buildServer } from './api/server.js';
import { loadConfig } from './config.js';
import { createReelIngest } from './module.js';

const cfg = loadConfig();
const ingest = createReelIngest(cfg);
await ingest.start({ workers: cfg.ROLE !== 'api' });

const app = cfg.ROLE === 'worker' ? null : buildServer(ingest);
if (app) await app.listen({ port: cfg.PORT, host: cfg.HOST });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    ingest.log.info({ sig }, 'shutting down');
    await app?.close();
    await ingest.stop();
    process.exit(0);
  });
}
