import { describe, expect, it } from 'vitest';
import { cents } from '../src/money';
import { buildOccSymbol, parseOccSymbol } from '../src/occ';

describe('occ symbols', () => {
  it('builds Alpaca-style symbols', () => {
    expect(buildOccSymbol('SPY', '2026-12-18', 'C', cents(60_000))).toBe('SPY261218C00600000');
    expect(buildOccSymbol('xyz', '2026-09-18', 'P', cents(9_050))).toBe('XYZ260918P00090500');
  });

  it('round-trips', () => {
    const parsed = parseOccSymbol('SPY261218C00600000');
    expect(parsed).toEqual({
      underlying: 'SPY',
      expirationIso: '2026-12-18',
      right: 'C',
      strikeCents: 60_000,
    });
  });

  it('rejects garbage', () => {
    expect(() => parseOccSymbol('not-an-occ')).toThrow();
  });
});
