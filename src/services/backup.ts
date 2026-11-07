import { spawn } from 'node:child_process';
import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { config } from '../config.js';
import type { Queryable } from '../db.js';
import type { Logger, Watcher } from '../watchers/types.js';

/**
 * Nightly database backup sent to the owner's Telegram (a bot + a chat id, set in the admin panel).
 * The dump is gzipped and encrypted with a password (openssl-compatible AES-256-CBC + PBKDF2), because
 * it holds merchant data and secrets; the wallet mnemonic is never in the database.
 * Restore: openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in FILE | gunzip | psql ...
 */

const SETTINGS_KEY = 'telegram_backup';
const STATUS_KEY = 'telegram_backup_status';
const PBKDF2_ITER = 100_000;
const TELEGRAM_MAX_BYTES = 49 * 1024 * 1024; // bots may upload up to 50 MB
export const BACKUP_TZ = 'Asia/Tehran';

export interface BackupSettings {
  enabled: boolean;
  bot_token: string | null;
  chat_id: string | null;
  password: string | null;
  hour: number; // local hour (Asia/Tehran) after which the nightly backup is sent
}

export interface BackupStatus {
  last_date: string | null; // local date (YYYY-MM-DD) of the last successful nightly backup
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_size: number | null;
}

const DEFAULTS: BackupSettings = { enabled: false, bot_token: null, chat_id: null, password: null, hour: 3 };
const EMPTY_STATUS: BackupStatus = { last_date: null, last_ok_at: null, last_error: null, last_error_at: null, last_size: null };

async function readSetting<T>(db: Queryable, key: string, fallback: T): Promise<T> {
  const { rows } = await db.query<{ value: T }>('SELECT value FROM system_settings WHERE key = $1', [key]);
  return rows[0] ? { ...fallback, ...rows[0].value } : fallback;
}
async function writeSetting(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO system_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export const getBackupSettings = (db: Queryable) => readSetting(db, SETTINGS_KEY, DEFAULTS);
export const getBackupStatus = (db: Queryable) => readSetting(db, STATUS_KEY, EMPTY_STATUS);
export const saveBackupSettings = (db: Queryable, s: BackupSettings) => writeSetting(db, SETTINGS_KEY, s);

export const maskToken = (t: string | null) => (t ? `${t.split(':')[0]}:***` : null);

/** Local date and hour in Tehran. */
export function localNow(d = new Date()): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: BACKUP_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Plain SQL dump of the whole database (pg_dump ships in the app image). */
export function pgDump(databaseUrl = config.DATABASE_URL): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('pg_dump', ['--no-owner', '--no-privileges', `--dbname=${databaseUrl}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (c: Buffer) => out.push(c));
    p.stderr.on('data', (c: Buffer) => (err += c.toString()));
    p.on('error', (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === 'ENOENT' ? 'pg_dump is not installed in this image — update the server (install.sh)' : e.message)),
    );
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`pg_dump failed: ${err.trim().slice(0, 300)}`))));
  });
}

/** Same format as `openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt` (sha256). */
export function encryptOpenssl(data: Buffer, password: string): Buffer {
  const salt = randomBytes(8);
  const kv = pbkdf2Sync(password, salt, PBKDF2_ITER, 48, 'sha256');
  const c = createCipheriv('aes-256-cbc', kv.subarray(0, 32), kv.subarray(32));
  return Buffer.concat([Buffer.from('Salted__'), salt, c.update(data), c.final()]);
}

async function telegram(token: string, method: string, body: FormData | Record<string, unknown>): Promise<void> {
  const isForm = body instanceof FormData;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    body: isForm ? body : JSON.stringify(body),
    headers: isForm ? undefined : { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(120_000),
  }).catch((e: Error) => {
    throw new Error(`Telegram unreachable (${(e.cause as Error | undefined)?.message ?? e.message}) — set a proxy in "Proxy & connectivity"`);
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || !json.ok) throw new Error(`Telegram: ${json.description ?? `HTTP ${res.status}`}`);
}

export async function sendTestMessage(s: Pick<BackupSettings, 'bot_token' | 'chat_id'>): Promise<void> {
  if (!s.bot_token || !s.chat_id) throw new Error('Bot token and chat id are required');
  await telegram(s.bot_token, 'sendMessage', { chat_id: s.chat_id, text: `✅ TrafxPayment (${config.DOMAIN ?? 'gateway'}): Telegram backup is connected.` });
}

/** Dumps, compresses, encrypts and uploads the database; records the result. Returns the file size. */
export async function sendBackup(db: Queryable, s: BackupSettings, opts: { nightly?: boolean } = {}): Promise<number> {
  const now = localNow();
  try {
    if (!s.bot_token || !s.chat_id || !s.password) throw new Error('Bot token, chat id and backup password are required');
    const gz = await promisify(gzip)(await pgDump());
    const file = encryptOpenssl(gz, s.password);
    if (file.length > TELEGRAM_MAX_BYTES) throw new Error(`Backup is ${(file.length / 1048576).toFixed(1)} MB; Telegram bots can upload at most 50 MB`);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `trafxpayment-${stamp}.sql.gz.enc`;
    const form = new FormData();
    form.set('chat_id', s.chat_id);
    form.set(
      'caption',
      `🗄 TrafxPayment backup ${now.date}${config.DOMAIN ? ` · ${config.DOMAIN}` : ''}\n` +
        `${(file.length / 1024).toFixed(0)} KB, encrypted with your backup password.\n` +
        `Restore: openssl enc -d -aes-256-cbc -pbkdf2 -iter ${PBKDF2_ITER} -in ${name} | gunzip > backup.sql`,
    );
    form.set('document', new Blob([new Uint8Array(file)]), name);
    await telegram(s.bot_token, 'sendDocument', form);
    const prev = await getBackupStatus(db);
    await writeSetting(db, STATUS_KEY, {
      ...prev,
      last_date: opts.nightly ? now.date : prev.last_date,
      last_ok_at: new Date().toISOString(),
      last_error: null,
      last_error_at: null,
      last_size: file.length,
    });
    return file.length;
  } catch (err) {
    const prev = await getBackupStatus(db);
    await writeSetting(db, STATUS_KEY, { ...prev, last_error: (err as Error).message, last_error_at: new Date().toISOString() });
    throw err;
  }
}

/** Worker job: once per local day, after the configured hour; retries a failed attempt every 30 minutes. */
export class TelegramBackupJob implements Watcher {
  readonly name = 'telegram-backup';
  readonly intervalMs = 5 * 60_000;
  constructor(
    private readonly db: Queryable,
    private readonly log: Logger,
  ) {}

  async tick(): Promise<void> {
    const s = await getBackupSettings(this.db);
    if (!s.enabled) return;
    const st = await getBackupStatus(this.db);
    const now = localNow();
    if (st.last_date === now.date || now.hour < s.hour) return;
    if (st.last_error_at && Date.now() - Date.parse(st.last_error_at) < 30 * 60_000) return;
    const size = await sendBackup(this.db, s, { nightly: true });
    this.log.info({ size }, 'telegram backup sent');
  }
}
