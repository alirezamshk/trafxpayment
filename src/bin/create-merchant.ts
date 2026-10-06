import { parseArgs } from 'node:util';
import { pool } from '../db.js';
import { createApiKey, createMerchant } from '../services/merchants.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    email: { type: 'string' },
    password: { type: 'string' },
    webhook: { type: 'string' },
    fee: { type: 'string' },
  },
});
if (!values.name || !values.email || !values.password) {
  console.error('Usage: npm run merchant:create -- --name "Shop" --email a@b.c --password "..." [--webhook https://...] [--fee 1.5]');
  process.exit(1);
}
const m = await createMerchant(pool, {
  name: values.name,
  email: values.email,
  password: values.password,
  webhookUrl: values.webhook,
  feePercent: values.fee ? Number(values.fee) : undefined,
});
const { key } = await createApiKey(pool, m.id);
console.log({ merchant_id: m.id, api_key: key, webhook_secret: m.webhook_secret, fee_percent: m.fee_percent });
await pool.end();
