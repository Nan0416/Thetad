/**
 * Volatility math — pure, no IO. Realized volatility from a price series and
 * the small selection helpers the implied-vol series needs. Implied vol
 * itself is inverted per-contract by impliedVol() in black-scholes.ts; this
 * module only picks which contract and blends the two sides.
 */

/** Trading days per year — the annualization factor for daily returns. */
export const TRADING_DAYS_PER_YEAR = 252;

export interface DailyClose {
  readonly dateIso: string;
  /** Any positive unit — vol is scale-free, so cents or dollars both work. */
  readonly close: number;
}

export interface RealizedVolPoint {
  readonly dateIso: string;
  /** Annualized volatility as a decimal, e.g. 0.18. */
  readonly vol: number;
}

/**
 * Annualized close-to-close realized volatility of a return series: the
 * sample standard deviation (n-1) of the log returns, scaled by
 * sqrt(periodsPerYear). Needs at least two returns.
 */
export function annualizedVol(
  returns: readonly number[],
  periodsPerYear = TRADING_DAYS_PER_YEAR,
): number {
  const n = returns.length;
  if (n < 2) throw new RangeError('need at least two returns');
  const mean = returns.reduce((a, r) => a + r, 0) / n;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

/**
 * Rolling annualized realized vol over `window` trailing log returns. Emits
 * one point per date that has a full window behind it, so the first point is
 * at closes[window] (window returns need window+1 closes). Non-positive or
 * non-finite closes break the return chain and are rejected.
 */
export function rollingRealizedVol(
  closes: readonly DailyClose[],
  window: number,
  periodsPerYear = TRADING_DAYS_PER_YEAR,
): readonly RealizedVolPoint[] {
  if (window < 2) throw new RangeError('window must be at least 2');
  const returns: { readonly dateIso: string; readonly r: number }[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!.close;
    const curr = closes[i]!.close;
    if (!(prev > 0) || !(curr > 0)) throw new RangeError('closes must be positive');
    returns.push({ dateIso: closes[i]!.dateIso, r: Math.log(curr / prev) });
  }
  const points: RealizedVolPoint[] = [];
  for (let j = window - 1; j < returns.length; j++) {
    const slice = returns.slice(j - window + 1, j + 1).map((x) => x.r);
    points.push({ dateIso: returns[j]!.dateIso, vol: annualizedVol(slice, periodsPerYear) });
  }
  return points;
}

/** Calendar days from `fromIso` to `toIso` (whole days, may be negative). */
export function calendarDaysBetween(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * The candidate expiration whose days-to-expiry from `asofIso` is closest to
 * `targetDte`. Only future expirations (dte > 0) are eligible; ties break to
 * the longer-dated one. Null when nothing is eligible.
 */
export function nearestExpirationToDte(
  expirations: readonly string[],
  asofIso: string,
  targetDte: number,
): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const expirationIso of expirations) {
    const dte = calendarDaysBetween(asofIso, expirationIso);
    if (dte <= 0) continue;
    const distance = Math.abs(dte - targetDte);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = expirationIso;
    }
  }
  return best;
}

/** Mean of the finite implied vols (either side may be null); null if both are. */
export function averageIv(callIv: number | null, putIv: number | null): number | null {
  const finite = [callIv, putIv].filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, v) => a + v, 0) / finite.length;
}
