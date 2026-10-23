import tls from 'node:tls';
import acme from 'acme-client';
import { config } from '../config.js';
import type { Queryable } from '../db.js';
import type { Logger, Watcher } from '../watchers/types.js';

/**
 * TLS certificate for API_TLS=acme-dns: the API serves HTTPS itself on a custom port, so the usual
 * HTTP-01 / TLS-ALPN-01 challenges (ports 80 / 443) are impossible. We use DNS-01 through the
 * Cloudflare API instead. All requests go through the outbound proxy set in the admin panel.
 * The worker issues and renews; the API process reads the result from the database.
 */

const CERT_KEY = 'tls_certificate';
const STATUS_KEY = 'tls_status';
const ACCOUNT_KEY = 'acme_account_key';
const RENEW_BEFORE_DAYS = 30;

export interface StoredCertificate {
  domain: string;
  cert: string; // full chain, PEM
  key: string; // PEM
  issuer: string;
  not_after: string;
  issued_at: string;
}

export interface CertificateStatus {
  state: 'ok' | 'pending' | 'error';
  message: string;
  checked_at: string;
}

async function getSetting<T>(db: Queryable, key: string): Promise<T | null> {
  const { rows } = await db.query<{ value: T }>('SELECT value FROM system_settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}
async function putSetting(db: Queryable, key: string, value: unknown) {
  await db.query(
    `INSERT INTO system_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export const getCertificate = (db: Queryable) => getSetting<StoredCertificate>(db, CERT_KEY);
export const getCertificateStatus = (db: Queryable) => getSetting<CertificateStatus>(db, STATUS_KEY);

/** Self-signed stand-in so the HTTPS port answers before the first real certificate exists. */
export async function placeholderCertificate(domain: string): Promise<{ cert: string; key: string }> {
  const key = await acme.crypto.createPrivateEcdsaKey();
  const [, cert] = await acme.crypto.createAlpnCertificate({ identifier: { type: 'dns', value: domain } } as never, 'placeholder', key);
  return { cert: cert.toString(), key: key.toString() };
}

/**
 * HTTPS options for a server that serves the stored certificate and switches to a new one (renewal)
 * without a restart. A self-signed stand-in answers until the first real certificate exists.
 */
export async function liveTlsOptions(db: Queryable, domain: string, log: (msg: string) => void, intervalMs = 60_000) {
  const placeholder = await placeholderCertificate(domain);
  let current = tls.createSecureContext(placeholder);
  let loadedAt = '';
  const refresh = async () => {
    const c = await getCertificate(db).catch(() => null);
    if (c && c.domain === domain && c.issued_at !== loadedAt) {
      current = tls.createSecureContext({ cert: c.cert, key: c.key });
      loadedAt = c.issued_at;
      log(`TLS certificate loaded (${c.issuer}, valid until ${c.not_after})`);
    }
  };
  await refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  timer.unref();
  const options: tls.TlsOptions = { ...placeholder, SNICallback: (_name, cb) => cb(null, current) };
  return { options, refresh, stop: () => clearInterval(timer) };
}

export function needsRenewal(cert: StoredCertificate | null, domain: string, now = new Date()): boolean {
  if (!cert || cert.domain !== domain) return true;
  return new Date(cert.not_after).getTime() - now.getTime() < RENEW_BEFORE_DAYS * 86_400_000;
}

// ---------------------------------------------------------------- Cloudflare DNS
export interface DnsApi {
  createTxt(name: string, value: string): Promise<() => Promise<void>>;
}

export function cloudflareDns(token: string, apiBase = 'https://api.cloudflare.com/client/v4'): DnsApi {
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
    if (!res.ok || !body.success) {
      throw new Error(`Cloudflare API ${res.status}: ${body.errors?.map((e) => e.message).join('; ') || 'request failed'}`);
    }
    return body.result as T;
  };
  return {
    async createTxt(name, value) {
      // The zone is the longest suffix of the name that exists in the account (payment.trafx.cloud -> trafx.cloud).
      const labels = name.split('.');
      let zoneId: string | undefined;
      for (let i = 1; i < labels.length - 1 && !zoneId; i++) {
        const zones = await call<{ id: string }[]>(`/zones?name=${encodeURIComponent(labels.slice(i).join('.'))}`);
        zoneId = zones[0]?.id;
      }
      if (!zoneId) throw new Error(`No Cloudflare zone for ${name} is visible to this API token`);
      const rec = await call<{ id: string }>(`/zones/${zoneId}/dns_records`, {
        method: 'POST',
        body: JSON.stringify({ type: 'TXT', name, content: value, ttl: 60 }),
      });
      return async () => {
        await call(`/zones/${zoneId}/dns_records/${rec.id}`, { method: 'DELETE' });
      };
    },
  };
}

// ---------------------------------------------------------------- issuing
export async function issueCertificate(
  db: Queryable,
  opts: { domain: string; email?: string; dns: DnsApi; directoryUrl: string; propagationMs?: number; log: Logger },
): Promise<StoredCertificate> {
  let accountKey = (await getSetting<{ key: string }>(db, ACCOUNT_KEY))?.key;
  if (!accountKey) {
    accountKey = (await acme.crypto.createPrivateEcdsaKey()).toString();
    await putSetting(db, ACCOUNT_KEY, { key: accountKey });
  }
  const client = new acme.Client({ directoryUrl: opts.directoryUrl, accountKey });
  const [key, csr] = await acme.crypto.createCsr({ commonName: opts.domain }, await acme.crypto.createPrivateEcdsaKey());

  const cleanups = new Map<string, () => Promise<void>>();
  const cert = await client.auto({
    csr,
    email: opts.email || undefined,
    termsOfServiceAgreed: true,
    challengePriority: ['dns-01'],
    // The server's own DNS may be filtered or slow; Let's Encrypt checks the record itself.
    skipChallengeVerification: true,
    challengeCreateFn: async (authz, _challenge, keyAuthorization) => {
      const name = `_acme-challenge.${authz.identifier.value}`;
      opts.log.info({ name }, 'creating ACME DNS record');
      cleanups.set(keyAuthorization, await opts.dns.createTxt(name, keyAuthorization));
      await new Promise((r) => setTimeout(r, opts.propagationMs ?? 20_000));
    },
    challengeRemoveFn: async (_authz, _challenge, keyAuthorization) => {
      await cleanups.get(keyAuthorization)?.().catch((err: Error) => opts.log.warn({ err: err.message }, 'could not remove ACME DNS record'));
    },
  });

  const info = acme.crypto.readCertificateInfo(cert);
  const stored: StoredCertificate = {
    domain: opts.domain,
    cert,
    key: key.toString(),
    issuer: info.issuer.commonName ?? 'unknown',
    not_after: info.notAfter.toISOString(),
    issued_at: new Date().toISOString(),
  };
  await putSetting(db, CERT_KEY, stored);
  return stored;
}

/** Worker job: obtains the certificate, renews it 30 days before expiry, retries failures every 15 minutes. */
export class CertificateJob implements Watcher {
  readonly name = 'tls-certificate';
  readonly intervalMs = 15 * 60_000;

  constructor(
    private readonly db: Queryable,
    private readonly log: Logger,
    private readonly opts = { domain: config.DOMAIN!, email: config.ACME_EMAIL, token: config.CF_API_TOKEN!, directoryUrl: config.ACME_DIRECTORY_URL },
  ) {}

  async tick() {
    if (!needsRenewal(await getCertificate(this.db), this.opts.domain)) return;
    const status = (state: CertificateStatus['state'], message: string) =>
      putSetting(this.db, STATUS_KEY, { state, message, checked_at: new Date().toISOString() });
    await status('pending', 'requesting a certificate from Let\'s Encrypt');
    try {
      const c = await issueCertificate(this.db, { ...this.opts, dns: cloudflareDns(this.opts.token), log: this.log });
      await status('ok', `issued by ${c.issuer}, valid until ${c.not_after}`);
      this.log.info({ domain: c.domain, notAfter: c.not_after }, 'TLS certificate issued');
    } catch (err) {
      const msg = (err as Error).message;
      await status('error', msg);
      this.log.error({ err: msg }, 'TLS certificate request failed; retrying in 15 minutes');
    }
  }
}
