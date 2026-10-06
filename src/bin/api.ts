import { buildServer } from '../api/server.js';
import { config } from '../config.js';

const app = await buildServer();
await app.listen({ port: config.PORT, host: config.HOST });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
