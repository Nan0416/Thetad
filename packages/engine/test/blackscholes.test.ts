import { describe, expect, it } from 'vitest';
import { bsGreeks, bsPrice, impliedVol } from '../src/core/blackscholes';

// Textbook reference: S=100, K=100, r=5%, vol=20%, T=1y.
const base = { spot: 100, strike: 100, vol: 0.2, tYears: 1, rate: 0.05 } as const;

describe('black-scholes', () => {
  it('prices the reference call and put', () => {
    expect(bsPrice({ ...base, right: 'C' })).toBeCloseTo(10.4506, 3);
    expect(bsPrice({ ...base, right: 'P' })).toBeCloseTo(5.5735, 3);
  });

  it('computes reference greeks', () => {
    const g = bsGreeks({ ...base, right: 'C' });
    expect(g.delta).toBeCloseTo(0.6368, 3);
    expect(g.gamma).toBeCloseTo(0.01876, 4);
    expect(bsGreeks({ ...base, right: 'P' }).delta).toBeCloseTo(0.6368 - 1, 3);
  });

  it('returns intrinsic value at expiry', () => {
    expect(bsPrice({ ...base, tYears: 0, right: 'C' })).toBe(0);
    expect(bsPrice({ ...base, spot: 110, tYears: 0, right: 'C' })).toBe(10);
  });

  it('recovers vol from price (IV round-trip)', () => {
    const price = bsPrice({ ...base, right: 'C' });
    const { vol: _drop, ...rest } = base;
    expect(impliedVol(price, { ...rest, right: 'C' })).toBeCloseTo(0.2, 4);
  });

  it('satisfies put-call parity with a dividend yield', () => {
    const divInput = { spot: 100, strike: 95, vol: 0.25, tYears: 0.5, rate: 0.05, divYield: 0.02 };
    const call = bsPrice({ ...divInput, right: 'C' });
    const put = bsPrice({ ...divInput, right: 'P' });
    const forwardParity = 100 * Math.exp(-0.02 * 0.5) - 95 * Math.exp(-0.05 * 0.5);
    expect(call - put).toBeCloseTo(forwardParity, 6);
    // dividend yield shrinks |delta| by e^{-qT}
    const withQ = bsGreeks({ ...divInput, right: 'P' }).delta;
    const withoutQ = bsGreeks({ ...divInput, divYield: 0, right: 'P' }).delta;
    expect(Math.abs(withQ)).not.toBeCloseTo(Math.abs(withoutQ), 4);
  });
});
