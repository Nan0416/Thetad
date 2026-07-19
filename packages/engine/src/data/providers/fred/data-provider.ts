import { z } from 'zod';

/**
 * Raw FRED v1 API client (https://fred.stlouisfed.org/docs/api/fred/).
 * Deliberately tied to FRED's own data model — api_key query auth, offset
 * pagination, observation values as strings with "." for missing — no
 * domain conversion here; the DataCatalog converts provider models into
 * ours. Sibling of AlpacaDataProvider, no shared interface.
 */

/** FRED release ids for the macro events thetad tracks. */
export const FRED_RELEASE_IDS = {
  CPI: 10,
  NFP: 50,
  PCE: 54,
} as const;

const releaseDatesResponseSchema = z.object({
  count: z.number().optional(),
  release_dates: z.array(z.object({ date: z.string() })).nullish(),
});

const observationsResponseSchema = z.object({
  count: z.number().optional(),
  observations: z.array(z.object({ date: z.string(), value: z.string() })).nullish(),
});

export interface FredObservation {
  readonly date: string;
  /** FRED's raw value string; "." means missing. */
  readonly value: string;
}

export interface FredDataProviderOptions {
  readonly apiKey: string;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
}

export interface GetReleaseDatesRequest {
  readonly releaseId: number;
}
export interface GetReleaseDatesResponse {
  /** Ascending; includes scheduled future dates (release_dates_with_no_data). */
  readonly dates: readonly string[];
}

export interface GetSeriesObservationsRequest {
  readonly seriesId: string;
  readonly observationStart?: string;
}
export interface GetSeriesObservationsResponse {
  readonly observations: readonly FredObservation[];
}

export class FredDataProvider {
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: FredDataProviderOptions) {
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async getReleaseDates(request: GetReleaseDatesRequest): Promise<GetReleaseDatesResponse> {
    const dates: string[] = [];
    const limit = 10_000;
    for (let offset = 0; ; offset += limit) {
      const page = await this.request(releaseDatesResponseSchema, '/fred/release/dates', {
        release_id: String(request.releaseId),
        include_release_dates_with_no_data: 'true',
        sort_order: 'asc',
        limit: String(limit),
        offset: String(offset),
      });
      const batch = page.release_dates ?? [];
      dates.push(...batch.map((d) => d.date));
      if (batch.length < limit) break;
    }
    return { dates };
  }

  async getSeriesObservations(
    request: GetSeriesObservationsRequest,
  ): Promise<GetSeriesObservationsResponse> {
    const observations: FredObservation[] = [];
    const limit = 100_000;
    for (let offset = 0; ; offset += limit) {
      const query: Record<string, string> = {
        series_id: request.seriesId,
        sort_order: 'asc',
        limit: String(limit),
        offset: String(offset),
      };
      if (request.observationStart) query.observation_start = request.observationStart;
      const page = await this.request(observationsResponseSchema, '/fred/series/observations', query);
      const batch = page.observations ?? [];
      observations.push(...batch);
      if (batch.length < limit) break;
    }
    return { observations };
  }

  private async request<T>(
    schema: z.ZodType<T>,
    path: string,
    query: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`https://api.stlouisfed.org${path}`);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('file_type', 'json');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchFn(url);
      if (response.ok) return schema.parse(await response.json());
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= 2) {
        throw new Error(`fred ${path} failed: ${response.status} ${await response.text()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500 * (attempt + 1)));
    }
  }
}
