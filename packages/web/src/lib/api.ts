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

/** [dateIso, vol] where vol is annualized, as a decimal (0.18 = 18%). */
export type VolPoint = readonly [string, number];

export interface VolatilityResponse {
  readonly symbol: string;
  readonly fromIso: string;
  readonly toIso: string;
  readonly targetDte: number;
  readonly rvWindows: readonly number[];
  readonly realized: Readonly<Record<string, readonly VolPoint[]>>;
  readonly impliedAtm: readonly VolPoint[];
  readonly vix: readonly VolPoint[];
}

export interface ContractIvResponse {
  readonly occSymbol: string;
  readonly right: OptionRight;
  readonly strikeCents: number;
  readonly expirationIso: string;
  readonly timeframe: Timeframe;
  /** [tsUtc, iv] over the contract's life within the window. */
  readonly points: readonly VolPoint[];
}

export interface VolatilityOptions {
  /** Constant-maturity target for the ATM IV line, in days. */
  readonly ivDte?: number;
  /** Realized-vol windows to compute; empty (the default) means no RV lines. */
  readonly rvWindows?: readonly number[];
}

export function fetchVolatility(
  symbol: string,
  fromIso: string,
  toIso: string,
  options: VolatilityOptions = {},
): Promise<VolatilityResponse> {
  const query = new URLSearchParams({ symbol, fromIso, toIso });
  if (options.ivDte) query.set('ivDte', String(options.ivDte));
  if (options.rvWindows?.length) query.set('rvWindows', options.rvWindows.join(','));
  return getJson(`/api/research/volatility?${query}`);
}

export function fetchContractIv(
  occSymbol: string,
  window: OptionBarsWindow = {},
): Promise<ContractIvResponse> {
  const query = new URLSearchParams();
  if (window.fromIso) query.set('fromIso', window.fromIso);
  if (window.toIso) query.set('toIso', window.toIso);
  if (window.timeframe) query.set('timeframe', window.timeframe);
  const suffix = query.size > 0 ? `?${query}` : '';
  return getJson(`/api/research/contract-iv/${occSymbol}${suffix}`);
}

/** One skew cell: [callCloseCents, callIv, putCloseCents, putIv]. A null
 * pair means that side has no data (unlisted or untraded on the date);
 * a price with a null iv means the close had no Black-Scholes solution. */
export type SkewCell = readonly [number | null, number | null, number | null, number | null];

export interface SkewExpiration {
  readonly expirationIso: string;
  readonly dte: number;
  readonly frequency: ExpirationFrequency | null;
}

export interface SkewResponse {
  readonly symbol: string;
  readonly dateIso: string;
  readonly spotCents: number;
  /** Risk-free rate used for every inversion, as a decimal. */
  readonly rate: number;
  readonly moneynessPct: number;
  readonly maxDte: number;
  /** Ascending; the heatmap's columns. */
  readonly expirations: readonly SkewExpiration[];
  /** Ascending; the heatmap's rows. */
  readonly strikesCents: readonly number[];
  /** grid[strikeIndex][expirationIndex]; null where nothing traded. */
  readonly grid: readonly (readonly (SkewCell | null)[])[];
  readonly droppedExpirations: number;
  /** Expirations with zero trades on the date (usually not yet listed), hidden. */
  readonly untradedExpirations: number;
}

export interface SkewOptions {
  readonly moneynessPct?: number;
  readonly maxDte?: number;
  readonly includeDailies?: boolean;
  /** Every listed strike in the window instead of the subsampled grid. */
  readonly allStrikes?: boolean;
}

export function fetchSkew(
  symbol: string,
  dateIso: string,
  options: SkewOptions = {},
): Promise<SkewResponse> {
  const query = new URLSearchParams({ symbol, dateIso });
  if (options.moneynessPct) query.set('moneynessPct', String(options.moneynessPct));
  if (options.maxDte) query.set('maxDte', String(options.maxDte));
  if (options.includeDailies) query.set('includeDailies', 'true');
  if (options.allStrikes) query.set('allStrikes', 'true');
  return getJson(`/api/research/skew?${query}`);
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
