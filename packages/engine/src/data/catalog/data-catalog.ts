import { join } from 'node:path';
import { z } from 'zod';
import { fromUsd, type Cents } from '../../core/money';
import { OccSymbol, type OptionRight } from '../../core/occ';
import type { Bar } from '../../core/types';
import type { AlpacaBar, AlpacaDataProvider } from '../providers/alpaca/data-provider';
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

const contractMinuteBarsSchema = z.object({
  v: z.literal(1),
  occSymbol: z.string(),
  fetchedAtUtc: z.string(),
  fetchedThroughIso: z.string(),
  bars: z.array(minuteBarTupleSchema),
});

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export interface DataCatalogOptions {
  readonly provider: AlpacaDataProvider;
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
 *   option-minute-bars/<OCC>.json            1-min option bars per contract
 *
 * Past years and expired contracts are immutable; current-year files
 * refresh via forceRefresh (the fetch:* scripts' --force).
 */
export class DataCatalog implements ContractCatalog {
  private readonly cache = new TieredCache();
  private readonly provider: AlpacaDataProvider;
  private readonly rootDir: string;

  constructor(options: DataCatalogOptions) {
    this.provider = options.provider;
    this.rootDir = options.rootDir ?? './data';
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

  // -- option minute bars ---------------------------------------------------

  async getOptionMinuteBarsRaw(occSymbol: string): Promise<ContractMinuteBars> {
    const { expirationIso } = OccSymbol.parse(occSymbol);
    return this.cache.get({
      path: join(this.rootDir, 'option-minute-bars', `${occSymbol}.json`),
      schema: contractMinuteBarsSchema as z.ZodType<ContractMinuteBars>,
      // Only a complete life (fetched through expiration) is served from
      // cache; still-active contracts refetch and extend on each touch.
      isUsable: (cached) => cached.fetchedThroughIso >= expirationIso,
      fetch: async () => {
        const { bars } = await this.provider.getOptionMinuteBars({
          occSymbol,
          endIso: expirationIso,
        });
        const todayIso = new Date().toISOString().slice(0, 10);
        return {
          v: 1 as const,
          occSymbol,
          fetchedAtUtc: new Date().toISOString(),
          fetchedThroughIso: expirationIso <= todayIso ? expirationIso : todayIso,
          bars: bars.map(toTuple),
        };
      },
    });
  }

  async getOptionMinuteBars(occSymbol: string): Promise<readonly Bar[]> {
    const snapshot = await this.getOptionMinuteBarsRaw(occSymbol);
    return tuplesToBars(occSymbol, snapshot.bars);
  }
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
