import { fromUsd, type Bar, type MarketSnapshot, type OptionQuote } from '@thetad/core';
import { z } from 'zod';
import { AlpacaHttp } from './http';

const barSchema = z.object({
  t: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
});

const barsResponseSchema = z.object({
  bars: z.array(barSchema).nullish(),
  next_page_token: z.string().nullish(),
});

const optionSnapshotSchema = z.object({
  latestQuote: z.object({ bp: z.number(), ap: z.number() }).nullish(),
  greeks: z
    .object({
      delta: z.number().nullish(),
      gamma: z.number().nullish(),
      theta: z.number().nullish(),
      vega: z.number().nullish(),
    })
    .nullish(),
  impliedVolatility: z.number().nullish(),
});

const optionSnapshotsResponseSchema = z.object({
  snapshots: z.record(optionSnapshotSchema),
  next_page_token: z.string().nullish(),
});

export interface GetStockBarsRequest {
  readonly symbol: string;
  readonly timeframe: '1Min' | '1Day';
  readonly startIso: string;
  readonly endIso: string;
}
export interface GetStockBarsResponse {
  readonly bars: readonly Bar[];
}

export interface GetOptionChainRequest {
  readonly underlying: string;
}
export interface GetOptionChainResponse {
  /** Keyed by OCC symbol. */
  readonly quotes: Readonly<Record<string, OptionQuote>>;
}

export interface GetSnapshotRequest {
  readonly occSymbolsByUnderlying: Readonly<Record<string, readonly string[]>>;
}
export interface GetSnapshotResponse {
  readonly snapshot: MarketSnapshot;
}

/** Alpaca market data API (data.alpaca.markets). */
export class AlpacaMarketData {
  constructor(private readonly http: AlpacaHttp) {}

  async getStockBars(request: GetStockBarsRequest): Promise<GetStockBarsResponse> {
    const bars: Bar[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {
        timeframe: request.timeframe,
        start: request.startIso,
        end: request.endIso,
        limit: '10000',
        adjustment: 'split',
        feed: 'sip',
      };
      if (pageToken) query.page_token = pageToken;
      const page = await this.http.request(
        barsResponseSchema,
        'GET',
        `/v2/stocks/${request.symbol}/bars`,
        { query },
      );
      for (const b of page.bars ?? []) {
        bars.push({
          symbol: request.symbol,
          tsUtc: b.t,
          openCents: fromUsd(b.o),
          highCents: fromUsd(b.h),
          lowCents: fromUsd(b.l),
          closeCents: fromUsd(b.c),
          volume: b.v,
        });
      }
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return { bars };
  }

  async getOptionChain(request: GetOptionChainRequest): Promise<GetOptionChainResponse> {
    const quotes: Record<string, OptionQuote> = {};
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = { feed: 'indicative', limit: '1000' };
      if (pageToken) query.page_token = pageToken;
      const page = await this.http.request(
        optionSnapshotsResponseSchema,
        'GET',
        `/v1beta1/options/snapshots/${request.underlying}`,
        { query },
      );
      for (const [occSymbol, snap] of Object.entries(page.snapshots)) {
        if (!snap.latestQuote) continue;
        const quote: OptionQuote = {
          occSymbol,
          bidCents: fromUsd(snap.latestQuote.bp),
          askCents: fromUsd(snap.latestQuote.ap),
          ...(snap.greeks?.delta != null && { delta: snap.greeks.delta }),
          ...(snap.greeks?.gamma != null && { gamma: snap.greeks.gamma }),
          ...(snap.greeks?.theta != null && { thetaPerDay: snap.greeks.theta }),
          ...(snap.greeks?.vega != null && { vegaPerPoint: snap.greeks.vega }),
          ...(snap.impliedVolatility != null && { iv: snap.impliedVolatility }),
        };
        quotes[occSymbol] = quote;
      }
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return { quotes };
  }

  /** Assemble a MarketSnapshot for the given contracts. asof is stamped here. */
  async getSnapshot(request: GetSnapshotRequest): Promise<GetSnapshotResponse> {
    const options: Record<string, OptionQuote> = {};
    for (const [underlying, occSymbols] of Object.entries(request.occSymbolsByUnderlying)) {
      const { quotes } = await this.getOptionChain({ underlying });
      for (const occ of occSymbols) {
        const quote = quotes[occ];
        if (quote) options[occ] = quote;
      }
    }
    return { snapshot: { asof: new Date(), equities: {}, options } };
  }
}
