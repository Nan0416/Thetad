import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fromUsd, type Cents } from '../core/money';
import { OccSymbol } from '../core/occ';
import { AlpacaHttp } from '../data/providers/alpaca/http';
import { atomicWriteJson } from '../data/storage/files';
import type { HistoricalDataSource } from './historicalData';

const stockBarsSchema = z.object({
  bars: z.array(z.object({ t: z.string(), c: z.number() })).nullish(),
  next_page_token: z.string().nullish(),
});

const optionBarsSchema = z.object({
  bars: z.record(z.array(z.object({ t: z.string(), c: z.number() }))).nullish(),
  next_page_token: z.string().nullish(),
});

const cacheFileSchema = z.object({
  v: z.literal(1),
  fetchedThroughIso: z.string(),
  closesByDate: z.record(z.number()),
});

const SYMBOLS_PER_REQUEST = 20;

/**
 * Alpaca-backed historical daily closes with a local JSON cache per option
 * contract (a contract's history is immutable once fetched through its
 * expiration, so the cache never invalidates).
 */
export class AlpacaHistoricalData implements HistoricalDataSource {
  constructor(
    private readonly http: AlpacaHttp,
    private readonly cacheDir: string,
  ) {}

  async getUnderlyingCloses(
    symbol: string,
    startIso: string,
    endIso: string,
  ): Promise<ReadonlyMap<string, Cents>> {
    const closes = new Map<string, Cents>();
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {
        timeframe: '1Day',
        start: startIso,
        end: `${endIso}T23:59:59Z`,
        limit: '10000',
        adjustment: 'split',
        feed: 'sip',
      };
      if (pageToken) query.page_token = pageToken;
      const page = await this.http.request(stockBarsSchema, 'GET', `/v2/stocks/${symbol}/bars`, {
        query,
      });
      for (const bar of page.bars ?? []) closes.set(bar.t.slice(0, 10), fromUsd(bar.c));
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return closes;
  }

  async getOptionCloses(
    occSymbols: readonly string[],
    startIso: string,
    endIso: string,
  ): Promise<ReadonlyMap<string, ReadonlyMap<string, Cents>>> {
    const result = new Map<string, ReadonlyMap<string, Cents>>();
    const misses: string[] = [];

    for (const occ of occSymbols) {
      const cached = this.readCache(occ);
      if (cached && cached.fetchedThroughIso >= this.fetchCeiling(occ, endIso)) {
        result.set(occ, toCentsMap(cached.closesByDate));
      } else {
        misses.push(occ);
      }
    }

    for (let i = 0; i < misses.length; i += SYMBOLS_PER_REQUEST) {
      const batch = misses.slice(i, i + SYMBOLS_PER_REQUEST);
      const closes = await this.fetchOptionBars(batch, startIso, endIso);
      for (const occ of batch) {
        const closesByDate = closes.get(occ) ?? {};
        this.writeCache(occ, this.fetchCeiling(occ, endIso), closesByDate);
        if (Object.keys(closesByDate).length > 0) result.set(occ, toCentsMap(closesByDate));
      }
    }
    return result;
  }

  private async fetchOptionBars(
    symbols: readonly string[],
    startIso: string,
    endIso: string,
  ): Promise<Map<string, Record<string, number>>> {
    const closes = new Map<string, Record<string, number>>();
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {
        symbols: symbols.join(','),
        timeframe: '1Day',
        start: startIso,
        end: endIso,
        limit: '10000',
      };
      if (pageToken) query.page_token = pageToken;
      const page = await this.http.request(optionBarsSchema, 'GET', '/v1beta1/options/bars', {
        query,
      });
      for (const [occ, bars] of Object.entries(page.bars ?? {})) {
        const existing = closes.get(occ) ?? {};
        for (const bar of bars) existing[bar.t.slice(0, 10)] = bar.c;
        closes.set(occ, existing);
      }
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return closes;
  }

  /** A contract's data is complete once fetched through its expiration. */
  private fetchCeiling(occ: string, endIso: string): string {
    const { expirationIso } = OccSymbol.parse(occ);
    return endIso < expirationIso ? endIso : expirationIso;
  }

  private cachePath(occ: string): string {
    return join(this.cacheDir, 'option-bars', `${occ}.json`);
  }

  private readCache(occ: string): z.infer<typeof cacheFileSchema> | null {
    const path = this.cachePath(occ);
    if (!existsSync(path)) return null;
    const parsed = cacheFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  }

  private writeCache(
    occ: string,
    fetchedThroughIso: string,
    closesByDate: Record<string, number>,
  ): void {
    const cached = this.readCache(occ);
    atomicWriteJson(this.cachePath(occ), {
      v: 1,
      fetchedThroughIso:
        cached && cached.fetchedThroughIso > fetchedThroughIso
          ? cached.fetchedThroughIso
          : fetchedThroughIso,
      closesByDate: { ...cached?.closesByDate, ...closesByDate },
    });
  }
}

function toCentsMap(closesByDate: Record<string, number>): ReadonlyMap<string, Cents> {
  return new Map(Object.entries(closesByDate).map(([date, usd]) => [date, fromUsd(usd)]));
}
