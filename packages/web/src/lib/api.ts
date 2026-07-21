/** Typed client for the daemon's research endpoints. Bars are compact
 * tuples [tsUtc, openCents, highCents, lowCents, closeCents, volume]. */

export type MinuteBarTuple = readonly [string, number, number, number, number, number];

export type OptionRight = 'C' | 'P';

export type ExpirationFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly';

export type Timeframe = '1Min' | '1Day';

export interface ContractsResponse {
  readonly underlying: string;
  readonly year: number;
  readonly expirations: Readonly<
    Record<
      string,
      { readonly putStrikesCents: readonly number[]; readonly callStrikesCents: readonly number[] }
    >
  >;
  readonly frequencies: Readonly<Record<string, ExpirationFrequency | null>>;
}

export interface StockBarsResponse {
  readonly symbol: string;
  readonly fromIso: string;
  readonly toIso: string;
  readonly timeframe: Timeframe;
  readonly bars: readonly MinuteBarTuple[];
}

export interface OptionBarsResponse {
  readonly occSymbol: string;
  readonly underlying: string;
  readonly expirationIso: string;
  readonly right: OptionRight;
  readonly strikeCents: number;
  readonly timeframe: Timeframe;
  readonly bars: readonly MinuteBarTuple[];
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T & { readonly error?: string };
  if (!response.ok) throw new Error(body.error ?? `${response.status} ${response.statusText}`);
  return body;
}

export function fetchContracts(underlying: string, year: number): Promise<ContractsResponse> {
  const query = new URLSearchParams({ underlying, year: String(year) });
  return getJson(`/api/research/contracts?${query}`);
}

export function fetchStockBars(
  symbol: string,
  fromIso: string,
  toIso: string,
  timeframe: Timeframe,
): Promise<StockBarsResponse> {
  const query = new URLSearchParams({ symbol, fromIso, toIso, timeframe });
  return getJson(`/api/research/stock-bars?${query}`);
}

export interface OptionBarsWindow {
  readonly fromIso?: string;
  readonly toIso?: string;
  readonly timeframe?: Timeframe;
}

export function fetchOptionBars(
  occSymbol: string,
  window: OptionBarsWindow = {},
): Promise<OptionBarsResponse> {
  const query = new URLSearchParams();
  if (window.fromIso) query.set('fromIso', window.fromIso);
  if (window.toIso) query.set('toIso', window.toIso);
  if (window.timeframe) query.set('timeframe', window.timeframe);
  const suffix = query.size > 0 ? `?${query}` : '';
  return getJson(`/api/research/option-bars/${occSymbol}${suffix}`);
}

/** OCC-style symbol as the engine formats it (no root padding). */
export function occSymbolFor(
  underlying: string,
  expirationIso: string,
  right: OptionRight,
  strikeCents: number,
): string {
  const [y, m, d] = expirationIso.split('-') as [string, string, string];
  const thousandths = String(strikeCents * 10).padStart(8, '0');
  return `${underlying.toUpperCase()}${y.slice(2)}${m}${d}${right}${thousandths}`;
}

export function fmtUsd(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

const nyTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Regular session (09:30–16:00 New York) — used to declutter minute bars. */
export function isRegularHoursNy(tsUtc: string): boolean {
  const parts = nyTime.formatToParts(new Date(tsUtc));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
