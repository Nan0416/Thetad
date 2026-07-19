import { impliedVol } from '../core/black-scholes';
import type { MarketCalendar } from '../core/calendar';
import { cents, toUsd, type Cents } from '../core/money';
import { OccSymbol } from '../core/occ';
import type { HistoricalDataSource } from './historical-data';
import { addDaysIso, pickExpiration } from './strategy';
import type { ShortPutParams } from './types';

const ATM_TARGET_DTE = 30;
const ATM_DTE_WINDOW = 10;

/**
 * Reconstruct a daily ATM implied-vol series for the underlying: for each
 * date, the ~30-DTE Friday expiration's ATM put IV solved from its bar close.
 * Days where the contract didn't trade or IV doesn't solve are absent.
 */
export async function buildAtmIvSeries(
  dates: readonly string[],
  spotByDate: ReadonlyMap<string, Cents>,
  dataSource: HistoricalDataSource,
  calendar: MarketCalendar,
  params: ShortPutParams,
): Promise<ReadonlyMap<string, number>> {
  const contractByDate = new Map<string, { occ: string; strikeCents: Cents; expIso: string }>();
  const occSymbols = new Set<string>();
  for (const dateIso of dates) {
    const spot = spotByDate.get(dateIso);
    if (spot === undefined) continue;
    const expIso = pickExpiration(
      dateIso,
      calendar,
      ATM_TARGET_DTE - ATM_DTE_WINDOW,
      ATM_TARGET_DTE + ATM_DTE_WINDOW,
    );
    if (!expIso) continue;
    const strikeCents = cents(Math.round(spot / 100) * 100);
    const occ = new OccSymbol(params.underlying, expIso, 'P', strikeCents).toString();
    contractByDate.set(dateIso, { occ, strikeCents, expIso });
    occSymbols.add(occ);
  }

  const first = dates[0] ?? params.startIso;
  const last = dates[dates.length - 1] ?? params.endIso;
  const closes = await dataSource.getOptionCloses([...occSymbols], first, addDaysIso(last, 1));

  const series = new Map<string, number>();
  for (const dateIso of dates) {
    const contract = contractByDate.get(dateIso);
    const spot = spotByDate.get(dateIso);
    if (!contract || spot === undefined) continue;
    const close = closes.get(contract.occ)?.get(dateIso);
    if (close === undefined) continue;
    const tYears = Math.max(1, diffDays(dateIso, contract.expIso)) / 365;
    const iv = impliedVol(toUsd(close), {
      spot: toUsd(spot),
      strike: toUsd(contract.strikeCents),
      tYears,
      rate: params.rate,
      divYield: params.divYield,
      right: 'P',
    });
    if (iv !== null) series.set(dateIso, iv);
  }
  return series;
}

/**
 * Classic IV Rank: (iv - min) / (max - min) x 100 over the trailing lookback
 * window (inclusive of today). Null until minObservations are available.
 */
export function ivRankOn(
  dateIso: string,
  ivSeries: ReadonlyMap<string, number>,
  orderedDates: readonly string[],
  lookbackDays: number,
  minObservations: number,
): number | null {
  const index = orderedDates.indexOf(dateIso);
  if (index < 0) return null;
  const today = ivSeries.get(dateIso);
  if (today === undefined) return null;
  const window = orderedDates.slice(Math.max(0, index - lookbackDays + 1), index + 1);
  const observations = window
    .map((d) => ivSeries.get(d))
    .filter((iv): iv is number => iv !== undefined);
  if (observations.length < minObservations) return null;
  const min = Math.min(...observations);
  const max = Math.max(...observations);
  if (max === min) return 50;
  return ((today - min) / (max - min)) * 100;
}

function diffDays(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000,
  );
}
