import { join } from 'node:path';
import { z } from 'zod';
import { fromUsd, type Cents } from '../../core/money';
import { OccSymbol, type OptionRight } from '../../core/occ';
import type { Bar } from '../../core/types';
import type { AlpacaBar, AlpacaDataProvider } from '../providers/alpaca/data-provider';
import type { FredDataProvider } from '../providers/fred/data-provider';
import { TieredCache } from './tiered-cache';

// ---------------------------------------------------------------------------
// Dataset shapes (cache file formats, all v1, all zod-validated on load).
// These are OUR models — integer cents, grouped, compact — converted from
// whatever data model the provider speaks.
// ---------------------------------------------------------------------------

/** One underlying-year of listed contracts: expiration -> strikes per right. */
export interface YearContracts {
  readonly v: 1;
  readonly underlying: string;
  readonly year: number;
  readonly fetchedAtUtc: string;
  readonly expirations: Readonly<
    Record<
      string,
      { readonly putStrikesCents: readonly number[]; readonly callStrikesCents: readonly number[] }
    >
  >;
}

/** Compact bar tuple: [tsUtc, openCents, highCents, lowCents, closeCents, volume]. */
export type MinuteBarTuple = readonly [string, number, number, number, number, number];

export interface YearMinuteBars {
  readonly v: 1;
  readonly symbol: string;
  readonly year: number;
  readonly timeframe: '1Min';
  readonly fetchedAtUtc: string;
  readonly bars: readonly MinuteBarTuple[];
}

export interface YearDailyBars {
  readonly v: 1;
  readonly symbol: string;
  readonly year: number;
  readonly timeframe: '1Day';
  readonly fetchedAtUtc: string;
  readonly bars: readonly MinuteBarTuple[];
}

export interface ContractMinuteBars {
  readonly v: 1;
  readonly occSymbol: string;
  readonly fetchedAtUtc: string;
  /** Data is complete once fetched through the contract's expiration. */
  readonly fetchedThroughIso: string;
  readonly bars: readonly MinuteBarTuple[];
}

/**
 * FRED series thetad consumes. Extend deliberately — verify id, frequency,
 * and units via /fred/series before adding (mnemonics are not a spec).
 */
export type FredSeriesId =
  | 'DGS1MO' // Market Yield on U.S. Treasury at 1-Month Constant Maturity, daily, percent
  | 'VIXCLS'; // CBOE Volatility Index (VIX) close, daily, index level

/** One year of a daily FRED series. */
export interface FredDailySeries {
  readonly v: 1;
  readonly seriesId: string;
  readonly year: number;
  readonly fetchedAtUtc: string;
  /** [dateIso, value] — value null where FRED reports missing ("."). */
  readonly observations: readonly (readonly [string, number | null])[];
}

/** The slice of the catalog the backtester's strike selection consumes. */
export interface ContractCatalog {
  strikesCentsFor(
    underlying: string,
    expirationIso: string,
    right: OptionRight,
  ): Promise<readonly Cents[] | null>;
}

// ---------------------------------------------------------------------------
// Cache-file schemas
// ---------------------------------------------------------------------------

const minuteBarTupleSchema = z.tuple([
  z.string(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);

const yearContractsSchema = z.object({
  v: z.literal(1),
  underlying: z.string(),
  year: z.number(),
  fetchedAtUtc: z.string(),
  expirations: z.record(
    z.object({
      putStrikesCents: z.array(z.number()),
      callStrikesCents: z.array(z.number()),
    }),
  ),
});

const yearMinuteBarsSchema = z.object({
  v: z.literal(1),
  symbol: z.string(),
  year: z.number(),
  timeframe: z.literal('1Min'),
  fetchedAtUtc: z.string(),
  bars: z.array(minuteBarTupleSchema),
});

const yearDailyBarsSchema = z.object({
  v: z.literal(1),
  symbol: z.string(),
  year: z.number(),
  timeframe: z.literal('1Day'),
  fetchedAtUtc: z.string(),
  bars: z.array(minuteBarTupleSchema),
});

const contractMinuteBarsSchema = z.object({
  v: z.literal(1),
  occSymbol: z.string(),
  fetchedAtUtc: z.string(),
  fetchedThroughIso: z.string(),
  bars: z.array(minuteBarTupleSchema),
});

const fredDailySeriesSchema = z.object({
  v: z.literal(1),
  seriesId: z.string(),
  year: z.number(),
  fetchedAtUtc: z.string(),
  observations: z.array(z.tuple([z.string(), z.number().nullable()])),
});

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export interface DataCatalogOptions {
  readonly provider: AlpacaDataProvider;
  readonly fredProvider: FredDataProvider;
  /** Root of the local cache tree (default ./data). */
  readonly rootDir?: string;
}

/**
 * Single entry point for cached market data. Every dataset follows the same
 * three tiers (memory -> file -> provider API, see TieredCache); the
 * provider speaks its own data model and this class converts it into ours.
 * Adding a dataset means one provider call, one schema, one typed method.
 *
 * Cache tree under rootDir:
 *   options/<SYMBOL>-<year>-contracts.json   listed contracts per year
 *   stock-minute-bars/<SYMBOL>-<year>.json   1-min stock bars per year
 *   stock-daily-bars/<SYMBOL>-<year>.json    1-day stock bars per year
 *   option-minute-bars/<OCC>.json            1-min option bars per contract
 *   option-daily-bars/<OCC>.json             1-day option bars per contract
 *
 * Past years and expired contracts are immutable. Still-growing files —
 * current-year contracts/daily bars, open contracts' daily bars — stay
 * usable for 24h, then refresh on the next touch; forceRefresh (the
 * fetch:* scripts' --force) skips straight to the provider.
 */
export class DataCatalog implements ContractCatalog {
  private readonly cache = new TieredCache();
  private readonly provider: AlpacaDataProvider;
  private readonly fredProvider: FredDataProvider;
  private readonly rootDir: string;

  constructor(options: DataCatalogOptions) {
    this.provider = options.provider;
    this.fredProvider = options.fredProvider;
    this.rootDir = options.rootDir ?? './data';
  }

  // -- reference series (FRED) ----------------------------------------------

  async getFredDailySeries(
    seriesId: FredSeriesId,
    year: number,
    forceRefresh = false,
  ): Promise<FredDailySeries> {
    return this.cache.get(
      {
        path: join(this.rootDir, 'reference', `fred-series-${seriesId}-${year}.json`),
        schema: fredDailySeriesSchema as z.ZodType<FredDailySeries>,
        fetch: async () => {
          const { observations } = await this.fredProvider.getSeriesObservations({
            seriesId,
            observationStart: `${year}-01-01`,
            observationEnd: `${year}-12-31`,
          });
          return {
            v: 1 as const,
            seriesId,
            year,
            fetchedAtUtc: new Date().toISOString(),
            observations: observations.map(
              (o) => [o.date, o.value === '.' ? null : Number(o.value)] as const,
            ),
          };
        },
      },
      forceRefresh,
    );
  }

  // -- contracts ------------------------------------------------------------

  async getContracts(
    underlying: string,
    year: number,
    forceRefresh = false,
  ): Promise<YearContracts> {
    const symbol = underlying.toUpperCase();
    return this.cache.get(
      {
        path: join(this.rootDir, 'options', `${symbol}-${year}-contracts.json`),
        schema: yearContractsSchema as z.ZodType<YearContracts>,
        // Past years are immutable; the current (or a future) year keeps
        // listing new weeklies, so refresh after 24h (a few requests).
        isUsable: (cached) =>
          year < new Date().getUTCFullYear() || isFresh(cached.fetchedAtUtc),
        fetch: async () => {
          const { contracts } = await this.provider.listOptionContracts({
            underlying: symbol,
            year,
          });
          return toYearContracts(symbol, year, contracts);
        },
      },
      forceRefresh,
    );
  }

  async strikesCentsFor(
    underlying: string,
    expirationIso: string,
    right: OptionRight,
  ): Promise<readonly Cents[] | null> {
    const { expirations } = await this.getContracts(underlying, Number(expirationIso.slice(0, 4)));
    const expiration = expirations[expirationIso];
    if (!expiration) return null;
    const strikes = right === 'P' ? expiration.putStrikesCents : expiration.callStrikesCents;
    return strikes as readonly Cents[];
  }

  // -- stock minute bars ----------------------------------------------------

  async getStockMinuteBarsRaw(
    symbol: string,
    year: number,
    forceRefresh = false,
  ): Promise<YearMinuteBars> {
    const upper = symbol.toUpperCase();
    return this.cache.get(
      {
        path: join(this.rootDir, 'stock-minute-bars', `${upper}-${year}.json`),
        schema: yearMinuteBarsSchema as z.ZodType<YearMinuteBars>,
        fetch: async () => {
          const { bars } = await this.provider.getStockMinuteBars({ symbol: upper, year });
          return {
            v: 1 as const,
            symbol: upper,
            year,
            timeframe: '1Min' as const,
            fetchedAtUtc: new Date().toISOString(),
            bars: bars.map(toTuple),
          };
        },
      },
      forceRefresh,
    );
  }

  async getStockMinuteBars(
    symbol: string,
    year: number,
    forceRefresh = false,
  ): Promise<readonly Bar[]> {
    const snapshot = await this.getStockMinuteBarsRaw(symbol, year, forceRefresh);
    return tuplesToBars(snapshot.symbol, snapshot.bars);
  }

  /**
   * Minute bars whose UTC date falls in [fromIso, toIso], spliced across
   * the per-year cache files the range touches.
   */
  async getStockMinuteBarsRange(
    symbol: string,
    fromIso: string,
    toIso: string,
  ): Promise<readonly Bar[]> {
    return this.spliceStockYears(symbol, fromIso, toIso, (year) =>
      this.getStockMinuteBarsRaw(symbol, year),
    );
  }

  // -- stock daily bars -----------------------------------------------------

  async getStockDailyBarsRaw(
    symbol: string,
    year: number,
    forceRefresh = false,
    mustCoverIso?: string,
  ): Promise<YearDailyBars> {
    const upper = symbol.toUpperCase();
    return this.cache.get(
      {
        path: join(this.rootDir, 'stock-daily-bars', `${upper}-${year}.json`),
        schema: yearDailyBarsSchema as z.ZodType<YearDailyBars>,
        // Past years are immutable; the current year grows a bar per
        // session, so refresh after 24h (cheap: a single request) — or
        // sooner when the caller needs a session the file may predate.
        isUsable: (cached) =>
          year < new Date().getUTCFullYear() ||
          (isFresh(cached.fetchedAtUtc) && coversSession(cached.fetchedAtUtc, mustCoverIso)),
        fetch: async () => {
          const { bars } = await this.provider.getStockDailyBars({ symbol: upper, year });
          return {
            v: 1 as const,
            symbol: upper,
            year,
            timeframe: '1Day' as const,
            fetchedAtUtc: new Date().toISOString(),
            bars: bars.map(toTuple),
          };
        },
      },
      forceRefresh,
    );
  }

  /**
   * Daily bars whose UTC date falls in [fromIso, toIso]. Pass mustCoverIso
   * when a specific completed session must be present (e.g. "yesterday"):
   * a within-TTL current-year file fetched before that session ended is
   * refreshed instead of served.
   */
  async getStockDailyBarsRange(
    symbol: string,
    fromIso: string,
    toIso: string,
    mustCoverIso?: string,
  ): Promise<readonly Bar[]> {
    return this.spliceStockYears(symbol, fromIso, toIso, (year) =>
      this.getStockDailyBarsRaw(symbol, year, false, mustCoverIso),
    );
  }

  private async spliceStockYears(
    symbol: string,
    fromIso: string,
    toIso: string,
    loadYear: (year: number) => Promise<{ readonly bars: readonly MinuteBarTuple[] }>,
  ): Promise<readonly Bar[]> {
    for (const iso of [fromIso, toIso]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`bad date: ${iso}`);
    }
    if (fromIso > toIso) throw new Error(`backwards range: ${fromIso} > ${toIso}`);
    const tuples: MinuteBarTuple[] = [];
    for (let year = Number(fromIso.slice(0, 4)); year <= Number(toIso.slice(0, 4)); year++) {
      const snapshot = await loadYear(year);
      // No push(...spread): a minute year holds ~200k tuples, far past
      // the engine's call-argument limit.
      for (const tuple of snapshot.bars) {
        const dateIso = tuple[0].slice(0, 10);
        if (dateIso >= fromIso && dateIso <= toIso) tuples.push(tuple);
      }
    }
    return tuplesToBars(symbol.toUpperCase(), tuples);
  }

  // -- option bars (minute + native daily, one contract file each) ----------

  async getOptionMinuteBarsRaw(occSymbol: string): Promise<ContractMinuteBars> {
    return this.optionBarsRaw(occSymbol, '1Min');
  }

  async getOptionMinuteBars(occSymbol: string): Promise<readonly Bar[]> {
    return tuplesToBars(occSymbol, (await this.getOptionMinuteBarsRaw(occSymbol)).bars);
  }

  async getOptionDailyBarsRaw(occSymbol: string): Promise<ContractMinuteBars> {
    return this.optionBarsRaw(occSymbol, '1Day');
  }

  async getOptionDailyBars(occSymbol: string): Promise<readonly Bar[]> {
    return tuplesToBars(occSymbol, (await this.getOptionDailyBarsRaw(occSymbol)).bars);
  }

  /**
   * Daily bars for many contracts at once. Cache hits are served per file;
   * misses are fetched from the provider in comma-joined batches and written
   * one file per contract, exactly as the single-contract path writes them
   * (a contract that never traded caches an empty life). Keyed by OCC symbol.
   */
  async getOptionDailyBarsBulk(
    occSymbols: readonly string[],
    mustCoverIso?: string,
  ): Promise<ReadonlyMap<string, readonly Bar[]>> {
    const unique = [...new Set(occSymbols)];
    const specs = unique.map((occSymbol) => this.optionBarsSpec(occSymbol, '1Day', mustCoverIso));
    const snapshots = await this.cache.getMany(specs, async (missingIndices) => {
      const missingOccs = missingIndices.map((i) => unique[i]!);
      const fetchedByOcc = new Map<string, ContractMinuteBars>();
      for (let at = 0; at < missingOccs.length; at += OPTION_BARS_BATCH) {
        const chunk = missingOccs.slice(at, at + OPTION_BARS_BATCH);
        // One shared end covers the whole chunk; a contract has no bars
        // past its own expiration, so the extra days fetch nothing.
        const endIso = chunk
          .map((occSymbol) => OccSymbol.parse(occSymbol).expirationIso)
          .sort()
          .at(-1)!;
        const { barsBySymbol } = await this.provider.getMultiOptionDailyBars({
          occSymbols: chunk,
          endIso,
        });
        for (const occSymbol of chunk) {
          fetchedByOcc.set(
            occSymbol,
            toContractBars(
              occSymbol,
              OccSymbol.parse(occSymbol).expirationIso,
              barsBySymbol[occSymbol] ?? [],
            ),
          );
        }
      }
      return missingIndices.map((i) => fetchedByOcc.get(unique[i]!)!);
    });
    return new Map(unique.map((occSymbol, i) => [occSymbol, tuplesToBars(occSymbol, snapshots[i]!.bars)]));
  }

  /** Cache spec shared by the single and bulk readers, so both hit one file. */
  private optionBarsSpec(occSymbol: string, timeframe: '1Min' | '1Day', mustCoverIso?: string) {
    const { expirationIso } = OccSymbol.parse(occSymbol);
    const dir = timeframe === '1Day' ? 'option-daily-bars' : 'option-minute-bars';
    return {
      path: join(this.rootDir, dir, `${occSymbol}.json`),
      schema: contractMinuteBarsSchema as z.ZodType<ContractMinuteBars>,
      // A complete life (fetched through expiration) is immutable. An open
      // contract's DAILY file stays usable for 24h (the skew page reads
      // past-session closes, final once the session ends) — unless the
      // caller needs a session it may predate; open MINUTE files refetch
      // and extend on every touch.
      isUsable: (cached: ContractMinuteBars) =>
        cached.fetchedThroughIso >= expirationIso ||
        (timeframe === '1Day' &&
          isFresh(cached.fetchedAtUtc) &&
          coversSession(cached.fetchedThroughIso, mustCoverIso)),
    };
  }

  private async optionBarsRaw(
    occSymbol: string,
    timeframe: '1Min' | '1Day',
  ): Promise<ContractMinuteBars> {
    const { expirationIso } = OccSymbol.parse(occSymbol);
    return this.cache.get({
      ...this.optionBarsSpec(occSymbol, timeframe),
      fetch: async () => {
        const { bars } =
          timeframe === '1Day'
            ? await this.provider.getOptionDailyBars({ occSymbol, endIso: expirationIso })
            : await this.provider.getOptionMinuteBars({ occSymbol, endIso: expirationIso });
        return toContractBars(occSymbol, expirationIso, bars);
      },
    });
  }
}

/** Batch size for the multi-symbol daily-bars endpoint (URL-length bound). */
const OPTION_BARS_BATCH = 100;

/** The shared freshness window for growing datasets (current-year files, open contracts). */
function isFresh(fetchedAtUtc: string): boolean {
  return Date.now() - Date.parse(fetchedAtUtc) < 24 * 3_600_000;
}

/**
 * Whether a growing file already contains the completed session of
 * `mustCoverIso`: its stamp (a fetch instant or fetched-through date) must
 * sit on a LATER UTC day — a same-day fetch may hold a partial session.
 */
function coversSession(stampIso: string, mustCoverIso: string | undefined): boolean {
  return mustCoverIso === undefined || stampIso.slice(0, 10) > mustCoverIso;
}

// ---------------------------------------------------------------------------
// Provider-model -> our-model conversion
// ---------------------------------------------------------------------------

function toYearContracts(
  underlying: string,
  year: number,
  contracts: readonly { type: 'put' | 'call'; expiration_date: string; strike_price: string }[],
): YearContracts {
  const strikesByExpiration = new Map<string, { P: Set<number>; C: Set<number> }>();
  for (const contract of contracts) {
    const entry = strikesByExpiration.get(contract.expiration_date) ?? {
      P: new Set<number>(),
      C: new Set<number>(),
    };
    entry[contract.type === 'put' ? 'P' : 'C'].add(fromUsd(Number(contract.strike_price)));
    strikesByExpiration.set(contract.expiration_date, entry);
  }
  const expirations: Record<string, { putStrikesCents: number[]; callStrikesCents: number[] }> = {};
  for (const [expirationIso, entry] of [...strikesByExpiration].sort()) {
    expirations[expirationIso] = {
      putStrikesCents: [...entry.P].sort((a, b) => a - b),
      callStrikesCents: [...entry.C].sort((a, b) => a - b),
    };
  }
  return { v: 1, underlying, year, fetchedAtUtc: new Date().toISOString(), expirations };
}

function toContractBars(
  occSymbol: string,
  expirationIso: string,
  bars: readonly AlpacaBar[],
): ContractMinuteBars {
  const todayIso = new Date().toISOString().slice(0, 10);
  return {
    v: 1,
    occSymbol,
    fetchedAtUtc: new Date().toISOString(),
    fetchedThroughIso: expirationIso <= todayIso ? expirationIso : todayIso,
    bars: bars.map(toTuple),
  };
}

function toTuple(bar: AlpacaBar): MinuteBarTuple {
  return [bar.t, fromUsd(bar.o), fromUsd(bar.h), fromUsd(bar.l), fromUsd(bar.c), bar.v];
}

function tuplesToBars(symbol: string, tuples: readonly MinuteBarTuple[]): readonly Bar[] {
  return tuples.map(([tsUtc, o, h, l, c, v]) => ({
    symbol,
    tsUtc,
    openCents: o as Cents,
    highCents: h as Cents,
    lowCents: l as Cents,
    closeCents: c as Cents,
    volume: v,
  }));
}

/** Nearest listed strike to a reference price; null on empty/missing input. */
export function nearestStrikeCents(
  strikes: readonly Cents[] | null,
  referenceCents: Cents,
): Cents | null {
  if (!strikes || strikes.length === 0) return null;
  let best = strikes[0]!;
  for (const strike of strikes) {
    if (Math.abs(strike - referenceCents) < Math.abs(best - referenceCents)) best = strike;
  }
  return best;
}
