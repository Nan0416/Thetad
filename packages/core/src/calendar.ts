/**
 * NYSE trading calendar. All public functions take/return UTC instants;
 * this module is the ONLY place that knows about America/New_York.
 *
 * Sessions: 09:30–16:00 ET, 09:30–13:00 ET on half days.
 * Holiday/half-day tables are maintained by hand (2024–2027).
 */

const HOLIDAYS = new Set([
  // 2024
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27',
  '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  // 2025 (incl. Jan 9 National Day of Mourning closure)
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27',
  '2025-12-25',
  // 2026 (Jul 4 observed Fri Jul 3)
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027 (Juneteenth observed Fri Jun 18, Jul 4 observed Mon Jul 5,
  // Christmas observed Fri Dec 24)
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

const HALF_DAYS = new Set([
  '2024-07-03', '2024-11-29', '2024-12-24',
  '2025-07-03', '2025-11-28', '2025-12-24',
  '2026-11-27', '2026-12-24',
  '2027-11-26',
]);

const CALENDAR_YEARS = { min: 2024, max: 2027 };

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

function assertCovered(dateIso: string): void {
  const year = Number(dateIso.slice(0, 4));
  if (year < CALENDAR_YEARS.min || year > CALENDAR_YEARS.max) {
    throw new Error(`date ${dateIso} outside calendar coverage ${CALENDAR_YEARS.min}-${CALENDAR_YEARS.max}`);
  }
}

/** The New York calendar date (YYYY-MM-DD) of a UTC instant. */
export function nyDateOf(asof: Date): string {
  return NY_DATE_FMT.format(asof);
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

export function isTradingDay(dateIso: string): boolean {
  assertCovered(dateIso);
  const [y, m, d] = dateIso.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !HOLIDAYS.has(dateIso);
}

export interface Session {
  dateIso: string;
  openUtc: Date;
  closeUtc: Date;
  isHalfDay: boolean;
}

export function sessionForDay(dateIso: string): Session | null {
  if (!isTradingDay(dateIso)) return null;
  const isHalfDay = HALF_DAYS.has(dateIso);
  return {
    dateIso,
    openUtc: nyWallToUtc(dateIso, 9, 30),
    closeUtc: nyWallToUtc(dateIso, isHalfDay ? 13 : 16, 0),
    isHalfDay,
  };
}

export function isMarketOpen(asof: Date): boolean {
  const session = sessionForDay(nyDateOf(asof));
  if (!session) return false;
  return asof >= session.openUtc && asof < session.closeUtc;
}

/** Minutes until today's close; null if the market is closed at `asof`. */
export function minutesToClose(asof: Date): number | null {
  if (!isMarketOpen(asof)) return null;
  const session = sessionForDay(nyDateOf(asof))!;
  return Math.floor((session.closeUtc.getTime() - asof.getTime()) / 60_000);
}

function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

/** Calendar days from the NY date of `asof` until `dateIso` (DTE convention). */
export function calendarDte(asof: Date, dateIso: string): number {
  const from = nyDateOf(asof);
  const ms = Date.parse(`${dateIso}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Trading days strictly after the NY date of `asof`, up to and including `dateIso`. */
export function tradingDaysUntil(asof: Date, dateIso: string): number {
  let cursor = nyDateOf(asof);
  let count = 0;
  while (cursor < dateIso) {
    cursor = addDaysIso(cursor, 1);
    if (isTradingDay(cursor)) count++;
  }
  return count;
}
