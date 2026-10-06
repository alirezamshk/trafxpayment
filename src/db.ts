import pg from 'pg';
import { config } from './config.js';

// NUMERIC -> string (never lose precision by parsing into a JS number).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

export type Queryable = Pick<pg.PoolClient, 'query'>;

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function getCursor(db: Queryable, key: string): Promise<string | undefined> {
  const { rows } = await db.query<{ value: string }>('SELECT value FROM cursors WHERE key = $1', [key]);
  return rows[0]?.value;
}

export async function setCursor(db: Queryable, key: string, value: string): Promise<void> {
  await db.query(
    `INSERT INTO cursors (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}
