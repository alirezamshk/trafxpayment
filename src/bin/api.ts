import { buildServer } from '../api/server.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { syncOutboundProxy } from '../services/network.js';

const app = await buildServer();
await syncOutboundProxy(pool, (m) => app.log.info(m));
await app.listen({ port: config.PORT, host: config.HOST });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
