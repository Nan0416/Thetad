/**
 * NYSE trading calendar, backed by bundled session data (see
 * scripts/generate-calendar.ts and scripts/fetch-calendar.ts) so nothing is
 * ever queried remotely at runtime. All public methods take/return UTC
 * instants; this module is the ONLY place that knows about America/New_York.
 */

import calendarData from './data/nyse-calendar.json';

export interface CalendarDay {
  /** YYYY-MM-DD (New York date). */
  readonly date: string;
  /** Wall-clock ET open, e.g. "09:30". */
  readonly open: string;
  /** Wall-clock ET close: "16:00", or "13:00" on half days. */
  readonly close: string;
}

export interface Session {
  readonly dateIso: string;
  readonly openUtc: Date;
  readonly closeUtc: Date;
  readonly isHalfDay: boolean;
}

const NY_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const NY_OFFSET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  timeZoneName: 'shortOffset',
});

export class MarketCalendar {
  private readonly byDate: ReadonlyMap<string, CalendarDay>;
  private readonly minDate: string;
  private readonly maxDate: string;
  private readonly sessionCache = new Map<string, Session | null>();

  private readonly dates: readonly string[];

  constructor(days: readonly CalendarDay[]) {
    if (days.length === 0) throw new Error('empty calendar');
    this.byDate = new Map(days.map((d) => [d.date, d]));
    this.dates = days.map((d) => d.date);
    this.minDate = days[0]!.date;
    this.maxDate = days[days.length - 1]!.date;
  }

  /** All trading days with startIso <= date <= endIso, ascending. */
  tradingDaysInRange(startIso: string, endIso: string): readonly string[] {
    this.assertCovered(startIso);
    this.assertCovered(endIso);
    return this.dates.filter((d) => d >= startIso && d <= endIso);
  }

  /** The last `count` trading days ending at (and including, if trading) endIso. */
  lastTradingDays(endIso: string, count: number): readonly string[] {
    this.assertCovered(endIso);
    const upTo = this.dates.filter((d) => d <= endIso);
    return upTo.slice(Math.max(0, upTo.length - count));
  }

  private static nyseInstance: MarketCalendar | null = null;

  /** The bundled NYSE calendar. */
  static nyse(): MarketCalendar {
    return (MarketCalendar.nyseInstance ??= new MarketCalendar(calendarData));
  }

  private assertCovered(dateIso: string): void {
    if (
      dateIso.slice(0, 4) < this.minDate.slice(0, 4) ||
      dateIso.slice(0, 4) > this.maxDate.slice(0, 4)
    ) {
      throw new Error(`date ${dateIso} outside calendar coverage ${this.minDate}..${this.maxDate}`);
    }
  }

  /** The New York calendar date (YYYY-MM-DD) of a UTC instant. */
  nyDateOf(asof: Date): string {
    return NY_DATE_FMT.format(asof);
  }

  isTradingDay(dateIso: string): boolean {
    this.assertCovered(dateIso);
    return this.byDate.has(dateIso);
  }

  sessionForDay(dateIso: string): Session | null {
    if (this.sessionCache.has(dateIso)) return this.sessionCache.get(dateIso)!;
    this.assertCovered(dateIso);
    const day = this.byDate.get(dateIso);
    let session: Session | null = null;
    if (day) {
      const [openH, openM] = splitWall(day.open);
      const [closeH, closeM] = splitWall(day.close);
      session = {
        dateIso,
        openUtc: nyWallToUtc(dateIso, openH, openM),
        closeUtc: nyWallToUtc(dateIso, closeH, closeM),
        isHalfDay: day.close !== '16:00',
      };
    }
    this.sessionCache.set(dateIso, session);
    return session;
  }

  isMarketOpen(asof: Date): boolean {
    const session = this.sessionForDay(this.nyDateOf(asof));
    if (!session) return false;
    return asof >= session.openUtc && asof < session.closeUtc;
  }

  /** Minutes until today's close; null if the market is closed at `asof`. */
  minutesToClose(asof: Date): number | null {
    if (!this.isMarketOpen(asof)) return null;
    const session = this.sessionForDay(this.nyDateOf(asof))!;
    return Math.floor((session.closeUtc.getTime() - asof.getTime()) / 60_000);
  }

  /** Calendar days from the NY date of `asof` until `dateIso` (DTE convention). */
  calendarDte(asof: Date, dateIso: string): number {
    const from = this.nyDateOf(asof);
    const ms = Date.parse(`${dateIso}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
    return Math.round(ms / 86_400_000);
  }

  /** Trading days strictly after the NY date of `asof`, up to and including `dateIso`. */
  tradingDaysUntil(asof: Date, dateIso: string): number {
    let cursor = this.nyDateOf(asof);
    let count = 0;
    while (cursor < dateIso) {
      cursor = addDaysIso(cursor, 1);
      if (this.isTradingDay(cursor)) count++;
    }
    return count;
  }
}

function splitWall(wall: string): [number, number] {
  const [h, m] = wall.split(':').map(Number) as [number, number];
  return [h, m];
}

function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function nyOffsetMinutes(at: Date): number {
  const part = NY_OFFSET_FMT.formatToParts(at).find((p) => p.type === 'timeZoneName');
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(part?.value ?? '');
  if (!m) throw new Error(`cannot determine NY offset at ${at.toISOString()}`);
  const hours = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  return hours * 60 + Math.sign(hours) * minutes;
}

/** UTC instant of a New York wall-clock time on a given date. */
export function nyWallToUtc(dateIso: string, hour: number, minute: number): Date {
  const [y, mo, d] = dateIso.split('-').map(Number) as [number, number, number];
  let utc = Date.UTC(y, mo - 1, d, hour, minute);
  // Two passes converge because DST transitions happen at 2am local,
  // never inside the trading session.
  for (let i = 0; i < 2; i++) {
    const offset = nyOffsetMinutes(new Date(utc));
    utc = Date.UTC(y, mo - 1, d, hour, minute) - offset * 60_000;
  }
  return new Date(utc);
}
