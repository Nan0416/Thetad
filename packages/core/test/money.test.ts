import { describe, expect, it } from 'vitest';
import { addCents, cents, formatUsd, fromUsd, mulCents, pctOfCents } from '../src/money';

describe('money', () => {
  it('rejects non-integer amounts', () => {
    expect(() => cents(1.5)).toThrow();
    expect(() => mulCents(cents(100), 0.5)).toThrow();
  });

  it('adds and multiplies exactly', () => {
    expect(addCents(cents(10), cents(20), cents(-5))).toBe(25);
    expect(mulCents(cents(183), 3)).toBe(549);
  });

  it('takes percentages in bps with half-away-from-zero rounding', () => {
    expect(pctOfCents(cents(40_000), 5_000)).toBe(20_000);
    expect(pctOfCents(cents(101), 5_000)).toBe(51);
    expect(pctOfCents(cents(-101), 5_000)).toBe(-51);
  });

  it('converts and formats dollars', () => {
    expect(fromUsd(1.83)).toBe(183);
    expect(formatUsd(cents(183))).toBe('$1.83');
    expect(formatUsd(cents(-50))).toBe('-$0.50');
  });
});
