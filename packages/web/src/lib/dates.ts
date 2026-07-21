import type { Timeframe } from './api';

/** The ISO date `days` before `fromIso` (UTC). */
export function isoDaysAgo(days: number, fromIso: string): string {
  return new Date(Date.parse(fromIso) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Above ~90 days, a window wants daily bars rather than minutes (~200k/yr). */
export function timeframeFor(fromIso: string, toIso: string): Timeframe {
  const days = (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000;
  return days > 90 ? '1Day' : '1Min';
}
