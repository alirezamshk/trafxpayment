/**
 * Exact decimal <-> base-unit conversions using BigInt. Never use floats for money.
 */

const DECIMAL_RE = /^\d+(\.\d+)?$/;

export function toBaseUnits(value: string, decimals: number): bigint {
  const v = value.trim();
  if (!DECIMAL_RE.test(v)) throw new Error(`Invalid decimal amount: ${value}`);
  const [whole = '0', frac = ''] = v.split('.');
  if (frac.length > decimals) {
    const extra = frac.slice(decimals);
    if (/[^0]/.test(extra)) throw new Error(`Amount ${value} has more than ${decimals} decimals`);
  }
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

export function fromBaseUnits(value: bigint | string, decimals: number): string {
  const v = BigInt(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Scale used for fixed-point arithmetic on prices/rates. */
const SCALE = 18;

/**
 * Converts a fiat price into asset base units: ceil(price / rate), rounded UP to
 * `displayDecimals` so the payer sees a clean amount and the merchant never receives less.
 */
export function quoteAmount(price: string, rate: string, decimals: number, displayDecimals: number): bigint {
  const p = toBaseUnits(price, SCALE);
  const r = toBaseUnits(normalizeDecimal(rate), SCALE);
  if (r === 0n) throw new Error('Rate must be positive');
  const precision = Math.min(decimals, displayDecimals);
  // amount in `precision` units = ceil(p * 10^precision / r)
  const num = p * 10n ** BigInt(precision);
  const units = (num + r - 1n) / r;
  return units * 10n ** BigInt(decimals - precision);
}

/** Converts JS-number-ish strings such as "1e-7" or "0.1234567890123456789" into a plain decimal with <= 18 digits. */
export function normalizeDecimal(value: string | number): string {
  const s = typeof value === 'number' ? value.toFixed(SCALE) : value;
  if (/e/i.test(s)) return Number(s).toFixed(SCALE);
  const [w = '0', f = ''] = s.split('.');
  return f ? `${w}.${f.slice(0, SCALE)}` : w;
}

export function applyTolerance(amount: bigint, tolerancePercent: number): bigint {
  if (tolerancePercent <= 0) return amount;
  const bps = BigInt(Math.round(tolerancePercent * 100)); // basis points
  return amount - (amount * bps) / 10000n;
}

/** "49.90000000" -> "49.9" (NUMERIC columns come back zero-padded). */
export function trimDecimal(v: string): string {
  return v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v;
}
