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

/** Alpaca market data API (data.alpaca.markets). */
export class AlpacaMarketData {
  constructor(private readonly http: AlpacaHttp) {}

  async getStockBars(
    symbol: string,
    timeframe: '1Min' | '1Day',
    startIso: string,
    endIso: string,
  ): Promise<Bar[]> {
    const bars: Bar[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {
        timeframe,
        start: startIso,
        end: endIso,
        limit: '10000',
        adjustment: 'split',
        feed: 'sip',
      };
      if (pageToken) query.page_token = pageToken;
      const page = await this.http.request(
        barsResponseSchema,
        'GET',
        `/v2/stocks/${symbol}/bars`,
        { query },
      );
      for (const b of page.bars ?? []) {
        bars.push({
          symbol,
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
    return bars;
  }

  /** Snapshot quotes + greeks for a whole chain, keyed by OCC symbol. */
  async getOptionChain(underlying: string): Promise<Record<string, OptionQuote>> {
    const quotes: Record<string, OptionQuote> = {};
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = { feed: 'indicative', limit: '1000' };
      if (pageToken) query.page_token = pageToken;
      const page = await this.http.request(
        optionSnapshotsResponseSchema,
        'GET',
        `/v1beta1/options/snapshots/${underlying}`,
        { query },
      );
      for (const [occSymbol, snap] of Object.entries(page.snapshots)) {
        if (!snap.latestQuote) continue;
        const quote: OptionQuote = {
          occSymbol,
          bidCents: fromUsd(snap.latestQuote.bp),
          askCents: fromUsd(snap.latestQuote.ap),
        };
        if (snap.greeks?.delta != null) quote.delta = snap.greeks.delta;
        if (snap.greeks?.gamma != null) quote.gamma = snap.greeks.gamma;
        if (snap.greeks?.theta != null) quote.thetaPerDay = snap.greeks.theta;
        if (snap.greeks?.vega != null) quote.vegaPerPoint = snap.greeks.vega;
        if (snap.impliedVolatility != null) quote.iv = snap.impliedVolatility;
        quotes[occSymbol] = quote;
      }
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return quotes;
  }

  /** Assemble a MarketSnapshot for the given contracts. asof is stamped here. */
  async getSnapshot(occSymbolsByUnderlying: Record<string, string[]>): Promise<MarketSnapshot> {
    const options: MarketSnapshot['options'] = {};
    for (const [underlying, occSymbols] of Object.entries(occSymbolsByUnderlying)) {
      const chain = await this.getOptionChain(underlying);
      for (const occ of occSymbols) {
        const quote = chain[occ];
        if (quote) options[occ] = quote;
      }
    }
    return { asof: new Date(), equities: {}, options };
  }
}
