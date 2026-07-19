import type { ZodType } from 'zod';

export class AlpacaAuthError extends Error {}
export class AlpacaRejectedError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
}
export class AlpacaRetryExhaustedError extends Error {}

export interface AlpacaHttpOptions {
  readonly keyId: string;
  readonly secretKey: string;
  readonly baseUrl: string;
  readonly maxRetries?: number;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
}

/**
 * Thin, owned HTTP client — no SDK. Retries 429/5xx with jittered backoff,
 * fails fast on 4xx logic errors, validates every response with zod at the
 * boundary so nothing unvalidated enters the system.
 */
export class AlpacaHttp {
  private readonly opts: Required<Omit<AlpacaHttpOptions, 'fetchFn'>> & { fetchFn: typeof fetch };

  constructor(opts: AlpacaHttpOptions) {
    this.opts = {
      maxRetries: 3,
      fetchFn: fetch,
      ...opts,
    };
  }

  async request<T>(
    schema: ZodType<T>,
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);

    for (let attempt = 0; ; attempt++) {
      const response = await this.opts.fetchFn(url, {
        method,
        headers: {
          'APCA-API-KEY-ID': this.opts.keyId,
          'APCA-API-SECRET-KEY': this.opts.secretKey,
          'content-type': 'application/json',
        },
        body: options.body === undefined ? null : JSON.stringify(options.body),
      });

      if (response.ok) {
        return schema.parse(await response.json());
      }
      const body = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new AlpacaAuthError(`alpaca auth failed (${response.status}): ${body}`);
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable) {
        throw new AlpacaRejectedError(`alpaca rejected ${method} ${path}`, response.status, body);
      }
      if (attempt >= this.opts.maxRetries) {
        throw new AlpacaRetryExhaustedError(
          `alpaca ${method} ${path} failed after ${attempt + 1} attempts: ${response.status} ${body}`,
        );
      }
      const backoffMs = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}
