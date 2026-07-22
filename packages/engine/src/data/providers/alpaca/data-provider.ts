import { z } from 'zod';
import { AlpacaHttp } from './http';

/**
 * Raw Alpaca market-data client for the DataCatalog. Deliberately tied to
 * Alpaca's own data model (field names, statuses, price-as-number-dollars) —
 * no domain conversion here; the DataCatalog converts provider models into
 * ours. Future providers (Polygon, ...) get their own sibling class rather
 * than a shared interface.
 */

/** Alpaca options data floor — nothing exists before this. */
const OPTIONS_DATA_FLOOR_ISO = '2024-02-01';

const optionContractSchema = z.object({
  symbol: z.string(),
  type: z.enum(['put', 'call']),
  expiration_date: z.string(),
  strike_price: z.string(),
});
export type AlpacaOptionContract = z.infer<typeof optionContractSchema>;

const barSchema = z.object({
  t: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
});
export type AlpacaBar = z.infer<typeof barSchema>;

const contractsResponseSchema = z.object({
  option_contracts: z.array(optionContractSchema).nullish(),
  next_page_token: z.string().nullish(),
});

const stockBarsResponseSchema = z.object({
  bars: z.array(barSchema).nullish(),
  next_page_token: z.string().nullish(),
});

const optionBarsResponseSchema = z.object({
  bars: z.record(z.array(barSchema)).nullish(),
  next_page_token: z.string().nullish(),
});

export interface AlpacaDataProviderOptions {
  /** data.alpaca.markets — bars. */
  readonly dataHttp: AlpacaHttp;
  /** paper-api/api.alpaca.markets — contract listings. */
  readonly tradingHttp: AlpacaHttp;
}

export interface ListOptionContractsRequest {
  readonly underlying: string;
  readonly year: number;
}
export interface ListOptionContractsResponse {
  /** Both expired (status=inactive) and active contracts, deduped by symbol. */
  readonly contracts: readonly AlpacaOptionContract[];
}

export interface GetStockMinuteBarsRequest {
  readonly symbol: string;
  readonly year: number;
}
export interface GetStockMinuteBarsResponse {
  readonly bars: readonly AlpacaBar[];
}

export interface GetStockDailyBarsRequest {
  readonly symbol: string;
  readonly year: number;
}
export interface GetStockDailyBarsResponse {
  readonly bars: readonly AlpacaBar[];
}

export interface GetOptionMinuteBarsRequest {
  readonly occSymbol: string;
  /** Fetch through this date (inclusive); start is Alpaca's data floor. */
  readonly endIso: string;
}
export interface GetOptionMinuteBarsResponse {
  readonly bars: readonly AlpacaBar[];
}

export interface GetOptionDailyBarsRequest {
  readonly occSymbol: string;
  /** Fetch through this date (inclusive); start is Alpaca's data floor. */
  readonly endIso: string;
}
export interface GetOptionDailyBarsResponse {
  readonly bars: readonly AlpacaBar[];
}

export interface GetMultiOptionDailyBarsRequest {
  /** One paged request cycle per call — callers chunk to keep the URL bounded. */
  readonly occSymbols: readonly string[];
  /** Fetch through this date (inclusive); start is Alpaca's data floor. */
  readonly endIso: string;
}
export interface GetMultiOptionDailyBarsResponse {
  /** Bars per requested symbol; a contract that never traded has no entry. */
  readonly barsBySymbol: Readonly<Record<string, readonly AlpacaBar[]>>;
}

export class AlpacaDataProvider {
  private readonly dataHttp: AlpacaHttp;
  private readonly tradingHttp: AlpacaHttp;

  constructor(options: AlpacaDataProviderOptions) {
    this.dataHttp = options.dataHttp;
    this.tradingHttp = options.tradingHttp;
  }

  async listOptionContracts(
    request: ListOptionContractsRequest,
  ): Promise<ListOptionContractsResponse> {
    const bySymbol = new Map<string, AlpacaOptionContract>();
    for (const status of ['inactive', 'active'] as const) {
      let pageToken: string | undefined;
      do {
        const query: Record<string, string> = {
          underlying_symbols: request.underlying,
          status,
          expiration_date_gte: `${request.year}-01-01`,
          expiration_date_lte: `${request.year}-12-31`,
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
          bySymbol.set(contract.symbol, contract);
        }
        pageToken = page.next_page_token ?? undefined;
      } while (pageToken);
    }
    return { contracts: [...bySymbol.values()] };
  }

  async getStockMinuteBars(
    request: GetStockMinuteBarsRequest,
  ): Promise<GetStockMinuteBarsResponse> {
    return { bars: await this.getStockBarsPaged(request.symbol, request.year, '1Min') };
  }

  async getStockDailyBars(request: GetStockDailyBarsRequest): Promise<GetStockDailyBarsResponse> {
    return { bars: await this.getStockBarsPaged(request.symbol, request.year, '1Day') };
  }

  private async getStockBarsPaged(
    symbol: string,
    year: number,
    timeframe: '1Min' | '1Day',
  ): Promise<readonly AlpacaBar[]> {
    const bars: AlpacaBar[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {
        timeframe,
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
      bars.push(...(page.bars ?? []));
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return bars;
  }

  async getOptionMinuteBars(
    request: GetOptionMinuteBarsRequest,
  ): Promise<GetOptionMinuteBarsResponse> {
    return { bars: await this.getOptionBarsPaged(request.occSymbol, request.endIso, '1Min') };
  }

  async getOptionDailyBars(
    request: GetOptionDailyBarsRequest,
  ): Promise<GetOptionDailyBarsResponse> {
    return { bars: await this.getOptionBarsPaged(request.occSymbol, request.endIso, '1Day') };
  }

  /** The same bars endpoint, comma-joined symbols — one request cycle for a chain slice. */
  async getMultiOptionDailyBars(
    request: GetMultiOptionDailyBarsRequest,
  ): Promise<GetMultiOptionDailyBarsResponse> {
    const barsBySymbol: Record<string, AlpacaBar[]> = {};
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {
        symbols: request.occSymbols.join(','),
        timeframe: '1Day',
        start: OPTIONS_DATA_FLOOR_ISO,
        end: `${request.endIso}T23:59:59Z`,
        limit: '10000',
      };
      if (pageToken) query.page_token = pageToken;
      const page = await this.dataHttp.request(
        optionBarsResponseSchema,
        'GET',
        '/v1beta1/options/bars',
        { query },
      );
      for (const [symbol, bars] of Object.entries(page.bars ?? {})) {
        (barsBySymbol[symbol] ??= []).push(...bars);
      }
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return { barsBySymbol };
  }

  private async getOptionBarsPaged(
    occSymbol: string,
    endIso: string,
    timeframe: '1Min' | '1Day',
  ): Promise<readonly AlpacaBar[]> {
    const bars: AlpacaBar[] = [];
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {
        symbols: occSymbol,
        timeframe,
        start: OPTIONS_DATA_FLOOR_ISO,
        end: `${endIso}T23:59:59Z`,
        limit: '10000',
      };
      if (pageToken) query.page_token = pageToken;
      const page = await this.dataHttp.request(
        optionBarsResponseSchema,
        'GET',
        '/v1beta1/options/bars',
        { query },
      );
      bars.push(...(page.bars?.[occSymbol] ?? []));
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);
    return bars;
  }
}
