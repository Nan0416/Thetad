import { describe, expect, it } from 'vitest';
import { cents } from '../src/money';
import { OccSymbol } from '../src/occ';

describe('OccSymbol', () => {
  it('builds Alpaca-style symbols', () => {
    expect(new OccSymbol('SPY', '2026-12-18', 'C', cents(60_000)).toString()).toBe(
      'SPY261218C00600000',
    );
    expect(new OccSymbol('xyz', '2026-09-18', 'P', cents(9_050)).toString()).toBe(
      'XYZ260918P00090500',
    );
  });

  it('round-trips through parse', () => {
    const parsed = OccSymbol.parse('SPY261218C00600000');
    expect(parsed.underlying).toBe('SPY');
    expect(parsed.expirationIso).toBe('2026-12-18');
    expect(parsed.right).toBe('C');
    expect(parsed.strikeCents).toBe(60_000);
    expect(parsed.toString()).toBe('SPY261218C00600000');
  });

  it('rejects garbage', () => {
    expect(() => OccSymbol.parse('not-an-occ')).toThrow();
    expect(() => new OccSymbol('SPY', '12/18/2026', 'C', cents(60_000))).toThrow();
  });
});
