import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fromUsd, type Cents } from '../core/money';
import type { Bar } from '../core/types';
import { AlpacaHttp } from '../data/providers/alpaca/http';
import { atomicWriteJson } from '../data/storage/files';

/**
 * Bars are stored as compact tuples to keep year files small (~250k bars):
 * [tsUtc, openCents, highCents, lowCents, closeCents, volume].
 */
export type MinuteBarTuple = readonly [string, number, number, number, number, number];

export interface YearMinuteBars {
  readonly v: 1;
  readonly symbol: string;
  readonly year: number;
  readonly timeframe: '1Min';
  readonly fetchedAtUtc: string;
  readonly bars: readonly MinuteBarTuple[];
}

/**
 * One-minute stock bars per symbol-year, cached as
 * data/stock-minute-bars/<SYMBOL>-<year>.json. The preload script and the
 * backtester share the cache; missing years are fetched on demand. Past
 * years are immutable; the current year refreshes with --force.
 */
export interface MinuteBarStore {
  getYear(symbol: string, year: number): Promise<readonly Bar[]>;
}

const barsResponseSchema = z.object({
  bars: z
    .array(
      z.object({
        t: z.string(),
        o: z.number(),
        h: z.number(),
        l: z.number(),
        c: z.number(),
        v: z.number(),
      }),
    )
    .nullish(),
  next_page_token: z.string().nullish(),
});

const yearFileSchema = z.object({
  v: z.literal(1),
  symbol: z.string(),
  year: z.number(),
  timeframe: z.literal('1Min'),
  fetchedAtUtc: z.string(),
  bars: z.array(z.tuple([z.string(), z.number(), z.number(), z.number(), z.number(), z.number()])),
});

export class AlpacaMinuteBarStore implements MinuteBarStore {
  private readonly memo = new Map<string, YearMinuteBars>();

  constructor(
    private readonly http: AlpacaHttp,
    private readonly cacheDir: string,
  ) {}

  async getYear(symbol: string, year: number, forceRefresh = false): Promise<readonly Bar[]> {
    return toBars(symbol, await this.getYearRaw(symbol, year, forceRefresh));
  }

  /** Snapshot form, for the preload script's reporting. */
  async getYearRaw(symbol: string, year: number, forceRefresh = false): Promise<YearMinuteBars> {
    const key = `${symbol.toUpperCase()}-${year}`;
    if (!forceRefresh) {
      const memoized = this.memo.get(key);
      if (memoized) return memoized;
      const cached = this.readCache(symbol, year);
      if (cached) {
        this.memo.set(key, cached);
        return cached;
      }
    }
    const snapshot = await this.fetchYear(symbol, year);
    atomicWriteJson(this.cachePath(symbol, year), snapshot);
    this.memo.set(key, snapshot);
    return snapshot;
  }

  private cachePath(symbol: string, year: number): string {
    return join(this.cacheDir, `${symbol.toUpperCase()}-${year}.json`);
  }

  private readCache(symbol: string, year: number): YearMinuteBars | null {
    const path = this.cachePath(symbol, year);
    if (!existsSync(path)) return null;
    const parsed = yearFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? (parsed.data as YearMinuteBars) : null;
  }

  private async fetchYear(symbol: string, year: number): Promise<YearMinuteBars> {
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
      const page = await this.http.request(
        barsResponseSchema,
        'GET',
        `/v2/stocks/${symbol.toUpperCase()}/bars`,
        { query },
      );
      for (const bar of page.bars ?? []) {
        bars.push([bar.t, fromUsd(bar.o), fromUsd(bar.h), fromUsd(bar.l), fromUsd(bar.c), bar.v]);
      }
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return {
      v: 1,
      symbol: symbol.toUpperCase(),
      year,
      timeframe: '1Min',
      fetchedAtUtc: new Date().toISOString(),
      bars,
    };
  }
}

function toBars(symbol: string, snapshot: YearMinuteBars): readonly Bar[] {
  return snapshot.bars.map(([tsUtc, o, h, l, c, v]) => ({
    symbol: symbol.toUpperCase(),
    tsUtc,
    openCents: o as Cents,
    highCents: h as Cents,
    lowCents: l as Cents,
    closeCents: c as Cents,
    volume: v,
  }));
}
