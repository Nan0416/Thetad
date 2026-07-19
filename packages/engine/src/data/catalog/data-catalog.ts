import { join } from 'node:path';
import { z } from 'zod';
import { fromUsd, type Cents } from '../../core/money';
import { OccSymbol, type OptionRight } from '../../core/occ';
import type { Bar } from '../../core/types';
import { AlpacaHttp } from '../providers/alpaca/http';
import { TieredCache } from './tiered-cache';

/** Alpaca options data floor — nothing exists before this. */
const OPTIONS_DATA_FLOOR_ISO = '2024-02-01';

// ---------------------------------------------------------------------------
// Dataset shapes (cache file formats, all v1, all zod-validated on load)
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

export interface ContractMinuteBars {
  readonly v: 1;
  readonly occSymbol: string;
  readonly fetchedAtUtc: string;
  /** Data is complete once fetched through the contract's expiration. */
  readonly fetchedThroughIso: string;
  readonly bars: readonly MinuteBarTuple[];
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
// Schemas
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

const contractMinuteBarsSchema = z.object({
  v: z.literal(1),
  occSymbol: z.string(),
  fetchedAtUtc: z.string(),
  fetchedThroughIso: z.string(),
  bars: z.array(minuteBarTupleSchema),
});

const contractsResponseSchema = z.object({
  option_contracts: z
    .array(
      z.object({
        symbol: z.string(),
        type: z.enum(['put', 'call']),
        expiration_date: z.string(),
        strike_price: z.string(),
      }),
    )
    .nullish(),
  next_page_token: z.string().nullish(),
});

const rawBarSchema = z.object({
  t: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
});

const stockBarsResponseSchema = z.object({
  bars: z.array(rawBarSchema).nullish(),
  next_page_token: z.string().nullish(),
});

const optionBarsResponseSchema = z.object({
  bars: z.record(z.array(rawBarSchema)).nullish(),
  next_page_token: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export interface DataCatalogOptions {
  /** data.alpaca.markets — bars. */
  readonly dataHttp: AlpacaHttp;
  /** paper-api/api.alpaca.markets — contract listings. */
  readonly tradingHttp: AlpacaHttp;
  /** Root of the local cache tree (default ./data). */
  readonly rootDir?: string;
}

/**
 * Single entry point for cached market data. Every dataset follows the same
 * three tiers (memory -> file -> provider API, see TieredCache); adding a
 * dataset means one fetch function, one schema, one typed method here.
 *
 * Cache tree under rootDir:
 *   options/<SYMBOL>-<year>-contracts.json   listed contracts per year
 *   stock-minute-bars/<SYMBOL>-<year>.json   1-min stock bars per year
 *   option-minute-bars/<OCC>.json            1-min option bars per contract
 *
 * Past years and expired contracts are immutable; current-year files
 * refresh via forceRefresh (the fetch:* scripts' --force).
 */
export class DataCatalog implements ContractCatalog {
  private readonly cache = new TieredCache();
  private readonly dataHttp: AlpacaHttp;
  private readonly tradingHttp: AlpacaHttp;
  private readonly rootDir: string;

  constructor(options: DataCatalogOptions) {
    this.dataHttp = options.dataHttp;
    this.tradingHttp = options.tradingHttp;
    this.rootDir = options.rootDir ?? './data';
  }

  // -- contracts ------------------------------------------------------------

  async getContracts(underlying: string, year: number, forceRefresh = false): Promise<YearContracts> {
    const symbol = underlying.toUpperCase();
    return this.cache.get(
      {
        path: join(this.rootDir, 'options', `${symbol}-${year}-contracts.json`),
        schema: yearContractsSchema as z.ZodType<YearContracts>,
        fetch: () => this.fetchContracts(symbol, year),
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
        fetch: () => this.fetchStockMinuteBars(upper, year),
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

  // -- option minute bars ---------------------------------------------------

  async getOptionMinuteBarsRaw(occSymbol: string): Promise<ContractMinuteBars> {
    const { expirationIso } = OccSymbol.parse(occSymbol);
    return this.cache.get({
      path: join(this.rootDir, 'option-minute-bars', `${occSymbol}.json`),
      schema: contractMinuteBarsSchema as z.ZodType<ContractMinuteBars>,
      // Only a complete life (fetched through expiration) is served from
      // cache; still-active contracts refetch and extend on each touch.
      isUsable: (cached) => cached.fetchedThroughIso >= expirationIso,
      fetch: () => this.fetchOptionMinuteBars(occSymbol, expirationIso),
    });
  }

  async getOptionMinuteBars(occSymbol: string): Promise<readonly Bar[]> {
    const snapshot = await this.getOptionMinuteBarsRaw(occSymbol);
    return tuplesToBars(occSymbol, snapshot.bars);
  }

  // -- provider fetches -----------------------------------------------------

  private async fetchContracts(underlying: string, year: number): Promise<YearContracts> {
    const strikesByExpiration = new Map<string, { P: Set<number>; C: Set<number> }>();
    for (const status of ['inactive', 'active'] as const) {
      let pageToken: string | undefined;
      do {
        const query: Record<string, string> = {
          underlying_symbols: underlying,
          status,
          expiration_date_gte: `${year}-01-01`,
          expiration_date_lte: `${year}-12-31`,
          limit: '10000',
        };
        if (pageToken) query.page_token = pageToken;
        const page = await this.tradingHttp.request(
          contractsResponseSchema,
          'GET',
          '/v2/options/contracts',
          { query },
        );
        for (const contract of page.option_contracts ?? []) {
          const entry = strikesByExpiration.get(contract.expiration_date) ?? {
            P: new Set<number>(),
            C: new Set<number>(),
          };
          entry[contract.type === 'put' ? 'P' : 'C'].add(fromUsd(Number(contract.strike_price)));
          strikesByExpiration.set(contract.expiration_date, entry);
        }
        pageToken = page.next_page_token ?? undefined;
      } while (pageToken);
    }

    const expirations: Record<string, { putStrikesCents: number[]; callStrikesCents: number[] }> =
      {};
    for (const [expirationIso, entry] of [...strikesByExpiration].sort()) {
      expirations[expirationIso] = {
        putStrikesCents: [...entry.P].sort((a, b) => a - b),
        callStrikesCents: [...entry.C].sort((a, b) => a - b),
      };
    }
    return { v: 1, underlying, year, fetchedAtUtc: new Date().toISOString(), expirations };
  }

  private async fetchStockMinuteBars(symbol: string, year: number): Promise<YearMinuteBars> {
    const bars: MinuteBarTuple[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {
        timeframe: '1Min',
        start: `${year}-01-01`,
        end: `${year}-12-31T23:59:59Z`,
        limit: '10000',
        adjustment: 'split',
        feed: 'sip',
      };
      if (pageToken) query.page_token = pageToken;
      const page = await this.dataHttp.request(
        stockBarsResponseSchema,
        'GET',
        `/v2/stocks/${symbol}/bars`,
        { query },
      );
      for (const bar of page.bars ?? []) {
        bars.push([bar.t, fromUsd(bar.o), fromUsd(bar.h), fromUsd(bar.l), fromUsd(bar.c), bar.v]);
      }
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return {
      v: 1,
      symbol,
      year,
      timeframe: '1Min',
      fetchedAtUtc: new Date().toISOString(),
      bars,
    };
  }

  private async fetchOptionMinuteBars(
    occSymbol: string,
    expirationIso: string,
  ): Promise<ContractMinuteBars> {
    const bars: MinuteBarTuple[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {
        symbols: occSymbol,
        timeframe: '1Min',
        start: OPTIONS_DATA_FLOOR_ISO,
        end: `${expirationIso}T23:59:59Z`,
        limit: '10000',
      };
      if (pageToken) query.page_token = pageToken;
      const page = await this.dataHttp.request(
        optionBarsResponseSchema,
        'GET',
        '/v1beta1/options/bars',
        { query },
      );
      for (const bar of page.bars?.[occSymbol] ?? []) {
        bars.push([bar.t, fromUsd(bar.o), fromUsd(bar.h), fromUsd(bar.l), fromUsd(bar.c), bar.v]);
      }
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    const todayIso = new Date().toISOString().slice(0, 10);
    return {
      v: 1,
      occSymbol,
      fetchedAtUtc: new Date().toISOString(),
      fetchedThroughIso: expirationIso <= todayIso ? expirationIso : todayIso,
      bars,
    };
  }
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
