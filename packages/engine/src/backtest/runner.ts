import type { MarketCalendar } from '../core/calendar';
import { nyWallToUtc } from '../core/calendar';
import { cents, type Cents } from '../core/money';
import { OccSymbol } from '../core/occ';
import type { HistoricalDataSource } from './historical-data';
import { buildAtmIvSeries, ivRankOn } from './iv-rank';
import { computeMetrics } from './metrics';
import {
  addDaysIso,
  buyFillCents,
  evaluateBacktestExit,
  pickExpiration,
  pickStrike,
  sellFillCents,
  strikeGrid,
} from './strategy';
import type {
  BacktestResult,
  ClosedTrade,
  EquityPoint,
  OpenShortPut,
  ShortPutParams,
} from './types';

/**
 * Event-driven daily backtest of the systematic short put. EOD resolution:
 * every decision uses that day's closes only; entries fill at the entry
 * day's close, exits at the exit day's close. Marks are trade-based bar
 * closes — days without a print are skipped (no exit evaluation on stale
 * data, same rule as the live engine).
 */
export async function runShortPutBacktest(
  params: ShortPutParams,
  dataSource: HistoricalDataSource,
  calendar: MarketCalendar,
): Promise<BacktestResult> {
  // Warm-up: extra trading days of history so IV Rank has a window at start.
  const warmupDays = calendar.lastTradingDays(params.startIso, params.ivRankLookbackDays + 10);
  const warmupStartIso = warmupDays[0] ?? params.startIso;
  const allDates = calendar.tradingDaysInRange(warmupStartIso, params.endIso);
  const tradeDates = allDates.filter((d) => d >= params.startIso);

  const spotByDate = await dataSource.getUnderlyingCloses(
    params.underlying,
    warmupStartIso,
    params.endIso,
  );
  const ivSeries = await buildAtmIvSeries(allDates, spotByDate, dataSource, calendar, params);

  const trades: ClosedTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let open: OpenShortPut | null = null;
  let openMarks: ReadonlyMap<string, Cents> | null = null;
  let lastMarkCost: Cents = cents(0);
  let realizedPnlCents = 0;
  let flatDays = 0;
  let blockedDays = 0;

  const dteOn = (dateIso: string, expirationIso: string): number =>
    calendar.calendarDte(nyWallToUtc(dateIso, 12, 0), expirationIso);

  const closePosition = (
    position: OpenShortPut,
    dateIso: string,
    markClose: Cents,
    reason: ClosedTrade['exitReason'],
  ): void => {
    const exitCostCents = buyFillCents(markClose, params);
    const pnlCents = cents(position.entryCreditCents - exitCostCents);
    trades.push({
      ...position,
      exitDateIso: dateIso,
      exitReason: reason,
      exitCostCents,
      pnlCents,
      holdTradingDays: calendar.tradingDaysUntil(
        nyWallToUtc(position.entryDateIso, 12, 0),
        dateIso,
      ),
    });
    realizedPnlCents += pnlCents;
  };

  for (const dateIso of tradeDates) {
    const spot = spotByDate.get(dateIso);
    const ivRank = ivRankOn(
      dateIso,
      ivSeries,
      allDates,
      params.ivRankLookbackDays,
      params.ivRankMinObservations,
    );

    if (open) {
      // Never evaluate exits on the entry day itself: EOD granularity means
      // the entry fill *is* that day's close.
      const markClose = open.entryDateIso === dateIso ? null : (openMarks?.get(dateIso) ?? null);
      if (markClose !== null) {
        lastMarkCost = buyFillCents(markClose, params);
        const reason = evaluateBacktestExit(
          open.entryCreditCents,
          lastMarkCost,
          dteOn(dateIso, open.expirationIso),
          params,
        );
        if (reason) {
          closePosition(open, dateIso, markClose, reason);
          open = null;
          openMarks = null;
        }
      }
    } else if (spot !== undefined) {
      flatDays++;
      if (ivRank === null || ivRank < params.minIvRank) {
        blockedDays++;
      } else {
        const entered = await tryEnter(dateIso, spot, ivRank, params, dataSource, calendar, dteOn);
        if (entered) {
          open = entered.position;
          openMarks = entered.marks;
          lastMarkCost = cents(open.entryCreditCents);
        }
      }
    }

    equityCurve.push({
      dateIso,
      equityCents: cents(realizedPnlCents + (open ? open.entryCreditCents - lastMarkCost : 0)),
      ivRank,
      inPosition: open !== null,
    });
  }

  // Mark-or-carry final close so every credit is accounted for.
  if (open) {
    const lastDate = tradeDates[tradeDates.length - 1]!;
    const finalMark = openMarks?.get(lastDate) ?? cents(Math.round(lastMarkCost / 100));
    closePosition(open, lastDate, finalMark, 'end_of_data');
    open = null;
  }

  const metrics = computeMetrics(trades, equityCurve, flatDays, blockedDays);
  return { params, trades, equityCurve, metrics };
}

async function tryEnter(
  dateIso: string,
  spot: Cents,
  ivRank: number,
  params: ShortPutParams,
  dataSource: HistoricalDataSource,
  calendar: MarketCalendar,
  dteOn: (dateIso: string, expirationIso: string) => number,
): Promise<{ position: OpenShortPut; marks: ReadonlyMap<string, Cents> } | null> {
  const expirationIso = pickExpiration(dateIso, calendar, params.dteMin, params.dteMax);
  if (!expirationIso) return null;

  // One fetch covers the entry-day strip AND the daily marks through expiry.
  const grid = strikeGrid(spot, 0.86, 1.0);
  const symbols = grid.map((k) =>
    new OccSymbol(params.underlying, expirationIso, 'P', k).toString(),
  );
  const closesBySymbol = await dataSource.getOptionCloses(
    symbols,
    dateIso,
    addDaysIso(expirationIso, 1),
  );

  const candidates = grid.flatMap((strikeCents) => {
    const occ = new OccSymbol(params.underlying, expirationIso, 'P', strikeCents).toString();
    const close = closesBySymbol.get(occ)?.get(dateIso);
    return close === undefined ? [] : [{ strikeCents, closeCents: close }];
  });

  const tYears = Math.max(1, dteOn(dateIso, expirationIso)) / 365;
  const selection = pickStrike(candidates, spot, tYears, params);
  if (!selection) return null;

  const occ = new OccSymbol(params.underlying, expirationIso, 'P', selection.strikeCents);
  const occSymbol = occ.toString();
  const entryClose = closesBySymbol.get(occSymbol)!.get(dateIso)!;
  return {
    position: {
      occSymbol,
      strikeCents: selection.strikeCents,
      expirationIso,
      entryDateIso: dateIso,
      entryCreditCents: sellFillCents(entryClose, params),
      entryDelta: selection.delta,
      entryIv: selection.iv,
      entryIvRank: ivRank,
      entrySpotCents: spot,
    },
    marks: closesBySymbol.get(occSymbol)!,
  };
}
