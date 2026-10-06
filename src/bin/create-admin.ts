import { parseArgs } from 'node:util';
import { pool } from '../db.js';
import { createAdmin } from '../services/merchants.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, password: { type: 'string' } } });
if (!values.email || !values.password) {
  console.error('Usage: npm run admin:create -- --email admin@example.com --password "..."');
  process.exit(1);
}
await createAdmin(pool, values.email, values.password);
console.log(`Admin ${values.email} ready`);
await pool.end();
