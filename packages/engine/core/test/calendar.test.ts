import { describe, expect, it } from 'vitest';
import { MarketCalendar } from '../src/calendar';

const calendar = MarketCalendar.nyse();

describe('nyse calendar (bundled data, 2016-2027)', () => {
  it('knows weekends and holidays', () => {
    expect(calendar.isTradingDay('2026-07-03')).toBe(false); // July 4 observed
    expect(calendar.isTradingDay('2026-07-04')).toBe(false); // Saturday
    expect(calendar.isTradingDay('2026-07-06')).toBe(true); // Monday
    expect(calendar.isTradingDay('2025-01-09')).toBe(false); // Carter day of mourning
    expect(calendar.isTradingDay('2018-12-05')).toBe(false); // Bush day of mourning
    expect(calendar.isTradingDay('2016-03-25')).toBe(false); // Good Friday 2016
    expect(calendar.isTradingDay('2022-01-03')).toBe(true); // Jan 1 2022 Sat: not observed
  });

  it('rejects dates outside data coverage', () => {
    expect(() => calendar.isTradingDay('2015-06-01')).toThrow(/coverage/);
    expect(() => calendar.isTradingDay('2031-01-02')).toThrow(/coverage/);
  });

  it('handles DST: EST vs EDT session opens (2026 spring-forward is Mar 8)', () => {
    expect(calendar.sessionForDay('2026-03-06')!.openUtc.toISOString()).toBe(
      '2026-03-06T14:30:00.000Z',
    );
    expect(calendar.sessionForDay('2026-03-09')!.openUtc.toISOString()).toBe(
      '2026-03-09T13:30:00.000Z',
    );
  });

  it('closes half days at 13:00 ET', () => {
    const friday = calendar.sessionForDay('2026-11-27')!;
    expect(friday.isHalfDay).toBe(true);
    expect(friday.closeUtc.toISOString()).toBe('2026-11-27T18:00:00.000Z');
    expect(calendar.sessionForDay('2018-12-24')!.isHalfDay).toBe(true);
  });

  it('computes minutes to close', () => {
    expect(calendar.minutesToClose(new Date('2026-07-06T19:30:00Z'))).toBe(30);
    expect(calendar.minutesToClose(new Date('2026-07-06T21:00:00Z'))).toBeNull(); // after close
    expect(calendar.minutesToClose(new Date('2026-07-04T15:00:00Z'))).toBeNull(); // Saturday
  });

  it('computes DTE from the NY date of the instant', () => {
    const asof = new Date('2026-07-17T18:00:00Z');
    expect(calendar.nyDateOf(asof)).toBe('2026-07-17');
    expect(calendar.calendarDte(asof, '2026-08-07')).toBe(21);
    // Late-evening UTC is still the same NY day
    expect(calendar.calendarDte(new Date('2026-07-18T02:00:00Z'), '2026-08-07')).toBe(21);
  });

  it('counts trading days', () => {
    // Week of Jul 6-10, 2026: five full trading days
    expect(calendar.tradingDaysUntil(new Date('2026-07-05T12:00:00Z'), '2026-07-10')).toBe(5);
  });
});
