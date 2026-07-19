import { describe, expect, it } from 'vitest';
import { bsPrice } from '../src/core/blackscholes';
import { MarketCalendar } from '../src/core/calendar';
import { cents, fromUsd } from '../src/core/money';
import { ivRankOn } from '../src/backtest/ivrank';
import {
  evaluateBacktestExit,
  pickExpiration,
  pickStrike,
  sellFillCents,
  buyFillCents,
  strikeGrid,
} from '../src/backtest/strategy';
import type { ShortPutParams } from '../src/backtest/types';

const calendar = MarketCalendar.nyse();

const params: ShortPutParams = {
  underlying: 'SPY',
  dteMin: 40,
  dteMax: 50,
  targetDelta: 0.16,
  deltaTolerance: 0.04,
  minIvRank: 30,
  profitTargetBps: 5_000,
  stopLossBps: 30_000,
  timeExitDte: 21,
  slippageCents: cents(3),
  feePerContractCents: cents(5),
  rate: 0.045,
  divYield: 0,
  ivRankLookbackDays: 252,
  ivRankMinObservations: 60,
  startIso: '2026-01-02',
  endIso: '2026-07-17',
};

describe('pickExpiration', () => {
  it('picks the Friday closest to the DTE window midpoint', () => {
    // 2026-07-06 + [40,50] covers Fri 2026-08-21 (46 DTE) only.
    expect(pickExpiration('2026-07-06', calendar, 40, 50)).toBe('2026-08-21');
    // Window [35,49] adds Fri 2026-08-14 (39 DTE); midpoint 42 -> 08-14 wins.
    expect(pickExpiration('2026-07-06', calendar, 35, 49)).toBe('2026-08-14');
  });

  it('adjusts a holiday Friday to the prior trading day', () => {
    // 2026-04-03 is Good Friday; expiration moves to Thursday 04-02 (36 DTE).
    expect(pickExpiration('2026-02-25', calendar, 35, 40)).toBe('2026-04-02');
  });

  it('returns null when no Friday lands in the window', () => {
    expect(pickExpiration('2026-07-06', calendar, 41, 44)).toBeNull();
  });
});

describe('pickStrike', () => {
  const spotCents = cents(50_000);
  const tYears = 45 / 365;
  const vol = 0.2;

  const candidates = strikeGrid(spotCents, 0.86, 1.0).map((strikeCents) => ({
    strikeCents,
    closeCents: fromUsd(
      bsPrice({
        spot: 500,
        strike: strikeCents / 100,
        vol,
        tYears,
        rate: params.rate,
        right: 'P',
      }),
    ),
  }));

  it('selects the strike nearest the target delta and recovers the vol', () => {
    const selection = pickStrike(candidates, spotCents, tYears, params);
    expect(selection).not.toBeNull();
    expect(Math.abs(Math.abs(selection!.delta) - params.targetDelta)).toBeLessThanOrEqual(0.04);
    expect(selection!.iv).toBeGreaterThan(0.18);
    expect(selection!.iv).toBeLessThan(0.22);
    expect(selection!.strikeCents).toBeLessThan(spotCents);
  });

  it('rejects when nothing is inside the delta tolerance', () => {
    const sparse = candidates.filter((c) => c.strikeCents % 2_500 === 0);
    const strict = { ...params, deltaTolerance: 0.0001 };
    expect(pickStrike(sparse, spotCents, tYears, strict)).toBeNull();
  });
});

describe('evaluateBacktestExit precedence', () => {
  const credit = cents(40_000);
  it('stop beats everything', () => {
    expect(evaluateBacktestExit(credit, cents(120_000), 5, params)).toBe('stop_loss');
  });
  it('profit beats time', () => {
    expect(evaluateBacktestExit(credit, cents(15_000), 20, params)).toBe('profit_target');
  });
  it('time exit fires regardless of P&L', () => {
    expect(evaluateBacktestExit(credit, cents(35_000), 21, params)).toBe('time_exit');
  });
  it('otherwise holds', () => {
    expect(evaluateBacktestExit(credit, cents(35_000), 22, params)).toBeNull();
  });
});

describe('fills', () => {
  it('applies slippage and fees against the trader', () => {
    expect(sellFillCents(cents(400), params)).toBe(397 * 100 - 5);
    expect(buyFillCents(cents(400), params)).toBe(403 * 100 + 5);
    // never sells below 1 cent per share
    expect(sellFillCents(cents(2), params)).toBe(100 - 5);
  });
});

describe('ivRankOn', () => {
  const dates = ['d1', 'd2', 'd3', 'd4'];
  const series = new Map([
    ['d1', 0.1],
    ['d2', 0.2],
    ['d3', 0.3],
    ['d4', 0.25],
  ]);
  it('normalizes min-max over the lookback', () => {
    expect(ivRankOn('d4', series, dates, 4, 2)).toBeCloseTo(75, 5);
    expect(ivRankOn('d3', series, dates, 3, 2)).toBeCloseTo(100, 5);
  });
  it('returns null below minimum observations', () => {
    expect(ivRankOn('d2', series, dates, 252, 60)).toBeNull();
  });
});
