import { describe, expect, it } from 'vitest';
import { buildStrikeGrid, capEvenly } from '../src/core/skew';
import { cents, type Cents } from '../src/core/money';

/** $95..$105 in $1 steps, as cents. */
function dollarLadder(fromCents: number, toCents: number, stepCents: number): Cents[] {
  const out: Cents[] = [];
  for (let s = fromCents; s <= toCents; s += stepCents) out.push(cents(s));
  return out;
}

describe('buildStrikeGrid', () => {
  const spot = cents(10_000); // $100

  it('keeps every strike inside the window when under the cap', () => {
    const grid = buildStrikeGrid({
      strikesCents: dollarLadder(9_000, 11_000, 100),
      spotCents: spot,
      windowBps: 500, // ±5% => $95..$105
      maxStrikes: 20,
    });
    expect(grid).toEqual(dollarLadder(9_500, 10_500, 100));
  });

  it('window bounds are inclusive', () => {
    const grid = buildStrikeGrid({
      strikesCents: [cents(9_400), cents(9_500), cents(10_500), cents(10_600)],
      spotCents: spot,
      windowBps: 500,
      maxStrikes: 20,
    });
    expect(grid).toEqual([9_500, 10_500]);
  });

  it('subsamples evenly by price and snaps ties to the lower strike', () => {
    const grid = buildStrikeGrid({
      strikesCents: dollarLadder(9_500, 10_500, 100),
      spotCents: spot,
      windowBps: 500,
      maxStrikes: 5,
    });
    // Targets 9500 / 9750 / 10000 / 10250 / 10500; 9750 and 10250 sit halfway
    // between $1 strikes, so the tie breaks down.
    expect(grid).toEqual([9_500, 9_700, 10_000, 10_200, 10_500]);
  });

  it('sorts and dedupes unordered input', () => {
    const grid = buildStrikeGrid({
      strikesCents: [cents(10_000), cents(9_900), cents(10_000), cents(10_100)],
      spotCents: spot,
      windowBps: 500,
      maxStrikes: 20,
    });
    expect(grid).toEqual([9_900, 10_000, 10_100]);
  });

  it('returns empty when nothing is in the window', () => {
    const grid = buildStrikeGrid({
      strikesCents: [cents(5_000)],
      spotCents: spot,
      windowBps: 500,
      maxStrikes: 20,
    });
    expect(grid).toEqual([]);
  });

  it('rejects a cap below two', () => {
    expect(() =>
      buildStrikeGrid({ strikesCents: [], spotCents: spot, windowBps: 500, maxStrikes: 1 }),
    ).toThrow(/maxStrikes/);
  });
});

describe('capEvenly', () => {
  it('passes short lists through untouched', () => {
    expect(capEvenly(['a', 'b', 'c'], 3)).toEqual(['a', 'b', 'c']);
  });

  it('samples evenly by index, keeping first and last', () => {
    expect(capEvenly(['a', 'b', 'c', 'd', 'e'], 3)).toEqual(['a', 'c', 'e']);
    expect(capEvenly([1, 2, 3, 4, 5, 6, 7], 4)).toEqual([1, 3, 5, 7]);
    expect(capEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2)).toEqual([1, 10]);
  });

  it('rejects a cap below two', () => {
    expect(() => capEvenly([1, 2, 3], 1)).toThrow(/max/);
  });
});
