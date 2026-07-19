import { describe, expect, it } from 'vitest';
import {
  calendarDte,
  isTradingDay,
  minutesToClose,
  nyDateOf,
  sessionForDay,
  tradingDaysUntil,
} from '../src/calendar';

describe('nyse calendar', () => {
  it('knows weekends and holidays', () => {
    expect(isTradingDay('2026-07-03')).toBe(false); // July 4 observed
    expect(isTradingDay('2026-07-04')).toBe(false); // Saturday
    expect(isTradingDay('2026-07-06')).toBe(true); // Monday
    expect(isTradingDay('2025-01-09')).toBe(false); // day of mourning closure
  });

  it('handles DST: EST vs EDT session opens (2026 spring-forward is Mar 8)', () => {
    expect(sessionForDay('2026-03-06')!.openUtc.toISOString()).toBe('2026-03-06T14:30:00.000Z');
    expect(sessionForDay('2026-03-09')!.openUtc.toISOString()).toBe('2026-03-09T13:30:00.000Z');
  });

  it('closes half days at 13:00 ET', () => {
    const friday = sessionForDay('2026-11-27')!;
    expect(friday.isHalfDay).toBe(true);
    expect(friday.closeUtc.toISOString()).toBe('2026-11-27T18:00:00.000Z');
  });

  it('computes minutes to close', () => {
    expect(minutesToClose(new Date('2026-07-06T19:30:00Z'))).toBe(30);
    expect(minutesToClose(new Date('2026-07-06T21:00:00Z'))).toBeNull(); // after close
    expect(minutesToClose(new Date('2026-07-04T15:00:00Z'))).toBeNull(); // Saturday
  });

  it('computes DTE from the NY date of the instant', () => {
    const asof = new Date('2026-07-17T18:00:00Z');
    expect(nyDateOf(asof)).toBe('2026-07-17');
    expect(calendarDte(asof, '2026-08-07')).toBe(21);
    // Late-evening UTC is still the same NY day
    expect(calendarDte(new Date('2026-07-18T02:00:00Z'), '2026-08-07')).toBe(21);
  });

  it('counts trading days', () => {
    // Week of Jul 6-10, 2026: five full trading days
    expect(tradingDaysUntil(new Date('2026-07-05T12:00:00Z'), '2026-07-10')).toBe(5);
  });
});
