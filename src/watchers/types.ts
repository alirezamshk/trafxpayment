export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface Watcher {
  readonly name: string;
  readonly intervalMs: number;
  tick(): Promise<void>;
}

export const consoleLogger: Logger = {
  info: (o, m) => console.log(JSON.stringify({ level: 'info', msg: m, ...(o as object) })),
  warn: (o, m) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...(o as object) })),
  error: (o, m) =>
    console.error(
      JSON.stringify({ level: 'error', msg: m, ...(o instanceof Error ? { err: o.message, stack: o.stack } : (o as object)) }),
    ),
  debug: (o, m) => {
    if (process.env.LOG_LEVEL === 'debug') console.log(JSON.stringify({ level: 'debug', msg: m, ...(o as object) }));
  },
};

export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}
