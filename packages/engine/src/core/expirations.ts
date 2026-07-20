import type { MarketCalendar } from './calendar';

/**
 * Listing cadence of an option expiration date, derived from the NYSE
 * calendar: quarterlies are the last trading day of Mar/Jun/Sep/Dec,
 * monthlies the (holiday-adjusted) third Friday, weeklies the remaining
 * Fridays (or the trading day standing in for a holiday Friday), and
 * everything else is a daily listing.
 */
export type ExpirationFrequency = 'daily' | 'weekly' | 'monthly' | 'quarterly';

const QUARTER_END_MONTHS = [3, 6, 9, 12];

export class ExpirationClassifier {
  constructor(private readonly calendar: MarketCalendar) {}

  classify(expirationIso: string): ExpirationFrequency {
    const month = Number(expirationIso.slice(5, 7));
    if (
      QUARTER_END_MONTHS.includes(month) &&
      expirationIso === this.lastTradingDayOfMonth(expirationIso)
    ) {
      return 'quarterly';
    }
    if (expirationIso === this.monthlyExpiration(expirationIso)) return 'monthly';
    const dow = dayOfWeekUtc(expirationIso);
    if (dow === 5) return 'weekly';
    if (dow === 4 && !this.calendar.isTradingDay(addDaysIso(expirationIso, 1))) return 'weekly';
    return 'daily';
  }

  /** The holiday-adjusted third Friday of the given date's month. */
  private monthlyExpiration(dateIso: string): string {
    const firstOfMonth = `${dateIso.slice(0, 8)}01`;
    const daysToFriday = (5 - dayOfWeekUtc(firstOfMonth) + 7) % 7;
    let candidate = addDaysIso(firstOfMonth, daysToFriday + 14);
    while (!this.calendar.isTradingDay(candidate)) candidate = addDaysIso(candidate, -1);
    return candidate;
  }

  private lastTradingDayOfMonth(dateIso: string): string {
    const [y, m] = dateIso.split('-').map(Number) as [number, number];
    let candidate = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    while (!this.calendar.isTradingDay(candidate)) candidate = addDaysIso(candidate, -1);
    return candidate;
  }
}

function dayOfWeekUtc(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay();
}

function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
