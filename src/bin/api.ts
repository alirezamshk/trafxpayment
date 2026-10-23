import { buildServer } from '../api/server.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { liveTlsOptions } from '../services/certificates.js';
import { syncOutboundProxy } from '../services/network.js';

// API_TLS=acme-dns: serve HTTPS ourselves with the certificate the worker obtains (see services/certificates.ts).
const log = (msg: string) => console.log(JSON.stringify({ level: 'info', msg }));
if (config.API_TLS === 'acme-dns' && !config.DOMAIN) throw new Error('API_TLS=acme-dns needs DOMAIN');
const tls = config.API_TLS === 'acme-dns' ? (await liveTlsOptions(pool, config.DOMAIN!, log)).options : undefined;

const app = await buildServer({ tls });
await syncOutboundProxy(pool, (m) => app.log.info(m));
await app.listen({ port: config.PORT, host: config.HOST });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
