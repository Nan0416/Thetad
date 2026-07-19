import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fromUsd, type Cents } from '../core/money';
import type { OptionRight } from '../core/occ';
import { AlpacaHttp } from '../data/providers/alpaca/http';
import { atomicWriteJson } from '../data/storage/files';

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

/**
 * The strike menu the market actually listed — replaces synthesized strike
 * grids. Backed by a per-underlying-year cache file that the preload script
 * and the backtester share; missing years are fetched and cached on demand.
 */
export interface ContractCatalog {
  getYear(underlying: string, year: number): Promise<YearContracts>;
  /** Listed strikes for one expiration; null if the expiration isn't listed. */
  strikesCentsFor(
    underlying: string,
    expirationIso: string,
    right: OptionRight,
  ): Promise<readonly Cents[] | null>;
}

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

const yearFileSchema = z.object({
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

/**
 * Alpaca-backed catalog via GET /v2/options/contracts (trading API base URL,
 * not the data API). Expired contracts require status=inactive; a past
 * year's listing is immutable, so its cache file never invalidates. The
 * current year's file grows stale as new contracts list — refresh with the
 * preload script's --force.
 */
export class AlpacaContractCatalog implements ContractCatalog {
  private readonly memo = new Map<string, YearContracts>();

  constructor(
    private readonly http: AlpacaHttp,
    private readonly cacheDir: string,
  ) {}

  async getYear(underlying: string, year: number, forceRefresh = false): Promise<YearContracts> {
    const key = `${underlying}-${year}`;
    if (!forceRefresh) {
      const memoized = this.memo.get(key);
      if (memoized) return memoized;
      const cached = this.readCache(underlying, year);
      if (cached) {
        this.memo.set(key, cached);
        return cached;
      }
    }
    const snapshot = await this.fetchYear(underlying, year);
    atomicWriteJson(this.cachePath(underlying, year), snapshot);
    this.memo.set(key, snapshot);
    return snapshot;
  }

  async strikesCentsFor(
    underlying: string,
    expirationIso: string,
    right: OptionRight,
  ): Promise<readonly Cents[] | null> {
    const { expirations } = await this.getYear(underlying, Number(expirationIso.slice(0, 4)));
    const expiration = expirations[expirationIso];
    if (!expiration) return null;
    const strikes = right === 'P' ? expiration.putStrikesCents : expiration.callStrikesCents;
    return strikes as readonly Cents[];
  }

  private cachePath(underlying: string, year: number): string {
    return join(this.cacheDir, `${underlying.toUpperCase()}-${year}-contracts.json`);
  }

  private readCache(underlying: string, year: number): YearContracts | null {
    const path = this.cachePath(underlying, year);
    if (!existsSync(path)) return null;
    const parsed = yearFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? (parsed.data as YearContracts) : null;
  }

  private async fetchYear(underlying: string, year: number): Promise<YearContracts> {
    const strikesByExpiration = new Map<string, { P: Set<number>; C: Set<number> }>();
    for (const status of ['inactive', 'active'] as const) {
      let pageToken: string | undefined;
      do {
        const query: Record<string, string> = {
          underlying_symbols: underlying.toUpperCase(),
          status,
          expiration_date_gte: `${year}-01-01`,
          expiration_date_lte: `${year}-12-31`,
          limit: '10000',
        };
        if (pageToken) query.page_token = pageToken;
        const page = await this.http.request(
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
    return {
      v: 1,
      underlying: underlying.toUpperCase(),
      year,
      fetchedAtUtc: new Date().toISOString(),
      expirations,
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
