import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fromUsd, type Cents } from '../core/money';
import { OccSymbol } from '../core/occ';
import type { Bar } from '../core/types';
import { AlpacaHttp } from '../data/providers/alpaca/http';
import { atomicWriteJson } from '../data/storage/files';
import type { MinuteBarTuple } from './minute-bar-store';

/** Alpaca options data floor — nothing exists before this. */
const OPTIONS_DATA_FLOOR_ISO = '2024-02-01';

export interface ContractMinuteBars {
  readonly v: 1;
  readonly occSymbol: string;
  readonly fetchedAtUtc: string;
  /** Data is complete once fetched through the contract's expiration. */
  readonly fetchedThroughIso: string;
  readonly bars: readonly MinuteBarTuple[];
}

/**
 * One-minute option bars, one cache file per contract
 * (data/option-minute-bars/<OCC>.json) covering the contract's whole life.
 * Minute bars are trade-based: minutes without prints are absent — sparse
 * far from the money, dense near it. Fetched lazily per contract; the
 * fetch:option-bars script preloads (mostly for testing).
 */
export interface OptionMinuteBarStore {
  getContract(occSymbol: string): Promise<readonly Bar[]>;
}

const barsResponseSchema = z.object({
  bars: z
    .record(
      z.array(
        z.object({
          t: z.string(),
          o: z.number(),
          h: z.number(),
          l: z.number(),
          c: z.number(),
          v: z.number(),
        }),
      ),
    )
    .nullish(),
  next_page_token: z.string().nullish(),
});

const contractFileSchema = z.object({
  v: z.literal(1),
  occSymbol: z.string(),
  fetchedAtUtc: z.string(),
  fetchedThroughIso: z.string(),
  bars: z.array(z.tuple([z.string(), z.number(), z.number(), z.number(), z.number(), z.number()])),
});

export class AlpacaOptionMinuteBarStore implements OptionMinuteBarStore {
  private readonly memo = new Map<string, ContractMinuteBars>();

  constructor(
    private readonly http: AlpacaHttp,
    private readonly cacheDir: string,
  ) {}

  async getContract(occSymbol: string): Promise<readonly Bar[]> {
    return toBars(occSymbol, await this.getContractRaw(occSymbol));
  }

  /** Snapshot form, for the preload script's reporting. */
  async getContractRaw(occSymbol: string): Promise<ContractMinuteBars> {
    const { expirationIso } = OccSymbol.parse(occSymbol);
    const memoized = this.memo.get(occSymbol);
    if (memoized) return memoized;

    const cached = this.readCache(occSymbol);
    if (cached && cached.fetchedThroughIso >= expirationIso) {
      this.memo.set(occSymbol, cached);
      return cached;
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const snapshot = await this.fetchContract(occSymbol, expirationIso, todayIso);
    atomicWriteJson(this.cachePath(occSymbol), snapshot);
    this.memo.set(occSymbol, snapshot);
    return snapshot;
  }

  private cachePath(occSymbol: string): string {
    return join(this.cacheDir, `${occSymbol}.json`);
  }

  private readCache(occSymbol: string): ContractMinuteBars | null {
    const path = this.cachePath(occSymbol);
    if (!existsSync(path)) return null;
    const parsed = contractFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? (parsed.data as ContractMinuteBars) : null;
  }

  private async fetchContract(
    occSymbol: string,
    expirationIso: string,
    todayIso: string,
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
      const page = await this.http.request(barsResponseSchema, 'GET', '/v1beta1/options/bars', {
        query,
      });
      for (const bar of page.bars?.[occSymbol] ?? []) {
        bars.push([bar.t, fromUsd(bar.o), fromUsd(bar.h), fromUsd(bar.l), fromUsd(bar.c), bar.v]);
      }
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return {
      v: 1,
      occSymbol,
      fetchedAtUtc: new Date().toISOString(),
      fetchedThroughIso: expirationIso <= todayIso ? expirationIso : todayIso,
      bars,
    };
  }
}

function toBars(occSymbol: string, snapshot: ContractMinuteBars): readonly Bar[] {
  return snapshot.bars.map(([tsUtc, o, h, l, c, v]) => ({
    symbol: occSymbol,
    tsUtc,
    openCents: o as Cents,
    highCents: h as Cents,
    lowCents: l as Cents,
    closeCents: c as Cents,
    volume: v,
  }));
}
