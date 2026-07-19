/**
 * Generate packages/engine/core/src/data/nyse-calendar.json from NYSE holiday rules,
 * 2016-2027. Output shape matches Alpaca's GET /v2/calendar so that
 * scripts/fetch-calendar.ts can overwrite this file with broker-authoritative
 * data without any consumer changes.
 *
 * Run: npm run calendar:generate
 */
import { writeFileSync } from 'node:fs';

const START_YEAR = 2016;
const END_YEAR = 2027;

// One-off full closures inside the range.
const SPECIAL_CLOSURES = new Set([
  '2018-12-05', // G.H.W. Bush day of mourning
  '2025-01-09', // Carter day of mourning
]);

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function dow(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay();
}

function addDays(dateIso: string, days: number): string {
  const t = new Date(`${dateIso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

function nthWeekday(y: number, month: number, weekday: number, n: number): string {
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const date = iso(y, month, d);
    if (Number(date.slice(8)) !== d) continue;
    if (dow(date) === weekday && ++count === n) return date;
  }
  throw new Error('unreachable');
}

function lastWeekday(y: number, month: number, weekday: number): string {
  for (let d = 31; d >= 1; d--) {
    const date = new Date(Date.UTC(y, month - 1, d));
    if (date.getUTCMonth() !== month - 1) continue;
    if (date.getUTCDay() === weekday) return date.toISOString().slice(0, 10);
  }
  throw new Error('unreachable');
}

/** Anonymous Gregorian algorithm -> Easter Sunday. */
function easterSunday(y: number): string {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}

/** Fixed-date holiday with NYSE observance: Sat -> preceding Fri, Sun -> following Mon.
 *  Exception: Jan 1 on a Saturday is NOT observed (rule 7.2). */
function observed(dateIso: string): string | null {
  const w = dow(dateIso);
  if (w === 6) return dateIso.slice(5) === '01-01' ? null : addDays(dateIso, -1);
  if (w === 0) return addDays(dateIso, 1);
  return dateIso;
}

function holidaysFor(y: number): Set<string> {
  const days: (string | null)[] = [
    observed(iso(y, 1, 1)),
    nthWeekday(y, 1, 1, 3), // MLK
    nthWeekday(y, 2, 1, 3), // Washington's Birthday
    addDays(easterSunday(y), -2), // Good Friday
    lastWeekday(y, 5, 1), // Memorial Day
    y >= 2022 ? observed(iso(y, 6, 19)) : null, // Juneteenth (NYSE from 2022)
    observed(iso(y, 7, 4)),
    nthWeekday(y, 9, 1, 1), // Labor Day
    nthWeekday(y, 11, 4, 4), // Thanksgiving
    observed(iso(y, 12, 25)),
  ];
  return new Set(days.filter((d): d is string => d !== null));
}

function halfDaysFor(y: number, holidays: Set<string>): Set<string> {
  const half = new Set<string>();
  // July 3: half when it's a weekday and July 4 is a full weekday holiday.
  const jul3 = iso(y, 7, 3);
  if (dow(jul3) >= 1 && dow(jul3) <= 5 && !holidays.has(jul3) && dow(iso(y, 7, 4)) >= 2) {
    half.add(jul3);
  }
  // Day after Thanksgiving: always a half day.
  half.add(addDays(nthWeekday(y, 11, 4, 4), 1));
  // Dec 24: half when it's a weekday and not itself the observed Christmas holiday.
  const dec24 = iso(y, 12, 24);
  if (dow(dec24) >= 1 && dow(dec24) <= 5 && !holidays.has(dec24) && dow(iso(y, 12, 25)) !== 0) {
    half.add(dec24);
  }
  return half;
}

interface CalendarDay {
  date: string;
  open: string;
  close: string;
}

const days: CalendarDay[] = [];
for (let y = START_YEAR; y <= END_YEAR; y++) {
  const holidays = holidaysFor(y);
  const half = halfDaysFor(y, holidays);
  for (let cursor = iso(y, 1, 1); cursor <= iso(y, 12, 31); cursor = addDays(cursor, 1)) {
    const w = dow(cursor);
    if (w === 0 || w === 6 || holidays.has(cursor) || SPECIAL_CLOSURES.has(cursor)) continue;
    days.push({ date: cursor, open: '09:30', close: half.has(cursor) ? '13:00' : '16:00' });
  }
}

const out = new URL('../../engine/core/src/data/nyse-calendar.json', import.meta.url);
writeFileSync(out, `[\n${days.map((d) => JSON.stringify(d)).join(',\n')}\n]\n`);
console.log(`wrote ${days.length} trading days (${START_YEAR}-${END_YEAR}) to ${out.pathname}`);
