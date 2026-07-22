import { describe, expect, it } from 'vitest';
import { backtestQuerySchema, toShortPutParams } from '../src/backtest';

describe('short-put backtest query mapping', () => {
  it('defaults mirror the CLI runner (run-backtest.ts)', () => {
    const query = backtestQuerySchema.parse({});
    expect(toShortPutParams(query, '2026-07-17')).toEqual({
      underlying: 'SPY',
      dteMin: 40,
      dteMax: 50,
      targetDelta: 0.16,
      deltaTolerance: 0.04,
      minIvRank: 30,
      profitTargetBps: 5_000,
      stopLossBps: 30_000,
      timeExitDte: 21,
      slippageCents: 3,
      feePerContractCents: 5,
      rate: 0.045,
      divYield: 0.012,
      ivRankLookbackDays: 252,
      ivRankMinObservations: 60,
      startIso: '2024-05-01',
      endIso: '2026-07-17',
    });
  });

  it('converts percent inputs to bps/decimals and uppercases the symbol', () => {
    const query = backtestQuerySchema.parse({
      underlying: 'qqq',
      profitPct: '65',
      stopPct: '250',
      ratePct: '5',
      divYieldPct: '1.5',
    });
    const params = toShortPutParams(query, '2026-01-02');
    expect(params.underlying).toBe('QQQ');
    expect(params.profitTargetBps).toBe(6_500);
    expect(params.stopLossBps).toBe(25_000);
    expect(params.rate).toBeCloseTo(0.05, 10);
    expect(params.divYield).toBeCloseTo(0.015, 10);
  });

  it('rejects out-of-range knobs', () => {
    expect(backtestQuerySchema.safeParse({ targetDelta: '1.5' }).success).toBe(false);
    expect(backtestQuerySchema.safeParse({ minIvRank: '120' }).success).toBe(false);
    expect(backtestQuerySchema.safeParse({ startIso: 'yesterday' }).success).toBe(false);
  });
});
