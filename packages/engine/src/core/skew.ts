/**
 * Grid selection for the volatility-skew surface — pure, no IO. The skew
 * endpoint plots strikes × expirations as a heatmap; these helpers pick
 * which strikes and expirations fit the grid. Implied vol itself is
 * inverted per-contract by impliedVol() in black-scholes.ts.
 */

import type { Cents } from './money';

export interface StrikeGridInput {
  /** Union of listed strikes across the charted expirations (any order). */
  readonly strikesCents: readonly Cents[];
  readonly spotCents: Cents;
  /** Half-width of the moneyness window in basis points (1500 = ±15%). */
  readonly windowBps: number;
  /** Cap on returned strikes (the heatmap's rows). */
  readonly maxStrikes: number;
}

/**
 * The heatmap's strike axis: listed strikes within the moneyness window,
 * subsampled to at most maxStrikes by snapping evenly spaced price targets
 * to the nearest listed strike (ties to the lower). Ascending, deduped.
 */
export function buildStrikeGrid(input: StrikeGridInput): readonly Cents[] {
  const { strikesCents, spotCents, windowBps, maxStrikes } = input;
  if (maxStrikes < 2) throw new RangeError('maxStrikes must be at least 2');
  const sorted = [...strikesCents].sort((a, b) => a - b);
  const within = sorted.filter(
    (strike, i) =>
      (i === 0 || strike !== sorted[i - 1]) &&
      strike * 10_000 >= spotCents * (10_000 - windowBps) &&
      strike * 10_000 <= spotCents * (10_000 + windowBps),
  );
  if (within.length <= maxStrikes) return within;

  const lo = within[0]!;
  const hi = within[within.length - 1]!;
  const picked = new Set<Cents>();
  for (let i = 0; i < maxStrikes; i++) {
    const target = lo + ((hi - lo) * i) / (maxStrikes - 1);
    picked.add(nearestSorted(within, target));
  }
  return [...picked].sort((a, b) => a - b);
}

function nearestSorted(sorted: readonly Cents[], target: number): Cents {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  const above = sorted[lo]!;
  const below = lo > 0 ? sorted[lo - 1]! : above;
  return target - below <= above - target ? below : above;
}

/**
 * At most `max` items, evenly sampled by index — first and last always
 * kept, so a capped expiration axis still spans the full DTE window.
 */
export function capEvenly<T>(items: readonly T[], max: number): readonly T[] {
  if (max < 2) throw new RangeError('max must be at least 2');
  if (items.length <= max) return items;
  const out: T[] = [];
  let previousIndex = -1;
  for (let i = 0; i < max; i++) {
    const index = Math.round((i * (items.length - 1)) / (max - 1));
    if (index !== previousIndex) out.push(items[index]!);
    previousIndex = index;
  }
  return out;
}
