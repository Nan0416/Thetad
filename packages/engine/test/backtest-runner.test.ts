import { describe, expect, it } from 'vitest';
import { bsPrice } from '../src/core/black-scholes';
import { MarketCalendar } from '../src/core/calendar';
import { cents, fromUsd, type Cents } from '../src/core/money';
import { OccSymbol } from '../src/core/occ';
import type { HistoricalDataSource } from '../src/backtest/historical-data';
import { runShortPutBacktest } from '../src/backtest/runner';
import type { ShortPutParams } from '../src/backtest/types';

const calendar = MarketCalendar.nyse();

/**
 * A synthetic world: any option's daily close is its Black-Scholes value at
 * constant vol against a supplied spot path. End-to-end runner tests with
 * zero network.
 */
class SyntheticDataSource implements HistoricalDataSource {
  constructor(
    private readonly spotByDate: ReadonlyMap<string, Cents>,
    private readonly vol: number | ((dateIso: string) => number),
    private readonly rate: number,
  ) {}

  private volOn(dateIso: string): number {
    return typeof this.vol === 'function' ? this.vol(dateIso) : this.vol;
  }

  async getUnderlyingCloses(
    _symbol: string,
    startIso: string,
    endIso: string,
  ): Promise<ReadonlyMap<string, Cents>> {
    return new Map([...this.spotByDate].filter(([date]) => date >= startIso && date <= endIso));
  }

  async getOptionCloses(
    occSymbols: readonly string[],
    startIso: string,
    endIso: string,
  ): Promise<ReadonlyMap<string, ReadonlyMap<string, Cents>>> {
    const result = new Map<string, ReadonlyMap<string, Cents>>();
    for (const occ of occSymbols) {
      const { strikeCents, expirationIso, right } = OccSymbol.parse(occ);
      const closes = new Map<string, Cents>();
      for (const [dateIso, spot] of this.spotByDate) {
        if (dateIso < startIso || dateIso > endIso || dateIso > expirationIso) continue;
        const tYears = Math.max(diffDays(dateIso, expirationIso), 0) / 365;
        const price = bsPrice({
          spot: spot / 100,
          strike: strikeCents / 100,
          vol: this.volOn(dateIso),
          tYears,
          rate: this.rate,
          right,
        });
        const close = fromUsd(price);
        if (close > 0) closes.set(dateIso, close);
      }
      if (closes.size > 0) result.set(occ, closes);
    }
    return result;
  }
}

function diffDays(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000,
  );
}

const baseParams: ShortPutParams = {
  underlying: 'SPY',
  dteMin: 40,
  dteMax: 50,
  targetDelta: 0.16,
  deltaTolerance: 0.05,
  minIvRank: 30,
  profitTargetBps: 5_000,
  stopLossBps: 30_000,
  timeExitDte: 21,
  slippageCents: cents(3),
  feePerContractCents: cents(5),
  rate: 0.045,
  divYield: 0,
  ivRankLookbackDays: 30,
  ivRankMinObservations: 5,
  startIso: '2026-03-02',
  endIso: '2026-07-17',
};

function flatSpotWorld(spotCents: Cents): Map<string, Cents> {
  const days = calendar.tradingDaysInRange('2026-01-02', '2026-07-17');
  return new Map(days.map((d) => [d, spotCents]));
}

describe('runShortPutBacktest (synthetic world)', () => {
  it('harvests theta in a calm flat market: profit-target exits, positive P&L', async () => {
    // Constant vol -> IV rank degenerates to 50, which passes the filter.
    const world = new SyntheticDataSource(flatSpotWorld(cents(50_000)), 0.2, baseParams.rate);
    const result = await runShortPutBacktest(baseParams, world, calendar);

    expect(result.trades.length).toBeGreaterThanOrEqual(2);
    for (const trade of result.trades.slice(0, -1)) {
      expect(trade.exitReason).toBe('profit_target');
      expect(trade.pnlCents).toBeGreaterThan(0);
      expect(Math.abs(Math.abs(trade.entryDelta) - 0.16)).toBeLessThanOrEqual(0.05);
    }
    expect(result.metrics.totalPnlCents).toBeGreaterThan(0);
    expect(result.metrics.winRate).toBeGreaterThan(0.5);
  });

  it('stops out on a crash', async () => {
    const spots = flatSpotWorld(cents(50_000));
    // 15% gap down two weeks into the trading window and stays there.
    const days = [...spots.keys()].filter((d) => d >= '2026-03-16');
    for (const d of days) spots.set(d, cents(42_500));
    const world = new SyntheticDataSource(spots, 0.2, baseParams.rate);
    const result = await runShortPutBacktest(baseParams, world, calendar);

    const stopped = result.trades.filter((t) => t.exitReason === 'stop_loss');
    expect(stopped.length).toBeGreaterThanOrEqual(1);
    expect(stopped[0]!.pnlCents).toBeLessThan(0);
    expect(stopped[0]!.exitDateIso).toBe('2026-03-16');
  });

  it('selects strikes from the contract catalog when one is provided', async () => {
    // A market that only lists half-dollar strikes ($x.50): a synthesized
    // grid can never produce one, so every entry proves catalog sourcing.
    const halfDollarCatalog = {
      async getYear() {
        throw new Error('unused');
      },
      async strikesCentsFor() {
        const strikes: Cents[] = [];
        for (let dollars = 400; dollars <= 520; dollars++) strikes.push(cents(dollars * 100 + 50));
        return strikes;
      },
    };
    const world = new SyntheticDataSource(flatSpotWorld(cents(50_000)), 0.2, baseParams.rate);
    const result = await runShortPutBacktest(
      baseParams,
      world,
      calendar,
      halfDollarCatalog as never,
    );
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    for (const trade of result.trades) {
      expect(trade.strikeCents % 100).toBe(50);
    }
  });

  it('respects the IV rank filter', async () => {
    // Vol regime: high during warm-up, low for the whole trading window --
    // today's IV always sits at the bottom of its trailing range, rank ~0.
    const regimeVol = (dateIso: string) => (dateIso < '2026-03-02' ? 0.35 : 0.15);
    const world = new SyntheticDataSource(flatSpotWorld(cents(50_000)), regimeVol, baseParams.rate);
    // Long lookback keeps the high-vol warm-up inside the window all test long.
    const result = await runShortPutBacktest(
      { ...baseParams, minIvRank: 90, ivRankLookbackDays: 252, ivRankMinObservations: 20 },
      world,
      calendar,
    );
    expect(result.trades.length).toBe(0);
    expect(result.metrics.filterBlockRate).toBe(1);
  });
});
