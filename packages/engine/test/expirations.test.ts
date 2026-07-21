import { describe, expect, it } from 'vitest';
import { aggregateDailyBars } from '../src/core/bars';
import { MarketCalendar } from '../src/core/calendar';
import { ExpirationClassifier } from '../src/core/expirations';
import { cents, type Cents } from '../src/core/money';
import type { Bar } from '../src/core/types';

const classifier = new ExpirationClassifier(MarketCalendar.nyse());

describe('ExpirationClassifier', () => {
  it('classifies third Fridays as monthly', () => {
    expect(classifier.classify('2025-03-21')).toBe('monthly');
    expect(classifier.classify('2025-12-19')).toBe('monthly');
    expect(classifier.classify('2026-01-16')).toBe('monthly');
  });

  it('adjusts the monthly to Thursday when the third Friday is Good Friday', () => {
    // 2025-04-18 was Good Friday; April's monthly expired 04-17.
    expect(classifier.classify('2025-04-17')).toBe('monthly');
  });

  it('classifies the last trading day of a quarter month as quarterly', () => {
    expect(classifier.classify('2025-03-31')).toBe('quarterly'); // Monday
    expect(classifier.classify('2025-06-30')).toBe('quarterly'); // Monday
    expect(classifier.classify('2024-12-31')).toBe('quarterly'); // Tuesday
  });

  it('classifies non-monthly Fridays as weekly', () => {
    expect(classifier.classify('2025-06-06')).toBe('weekly');
    expect(classifier.classify('2025-03-07')).toBe('weekly');
  });

  it('classifies the Thursday standing in for a holiday Friday as weekly', () => {
    // 2025-07-04 (Friday) was Independence Day.
    expect(classifier.classify('2025-07-03')).toBe('weekly');
  });

  it('classifies other weekdays as daily', () => {
    expect(classifier.classify('2025-07-01')).toBe('daily'); // Tuesday
    expect(classifier.classify('2025-06-25')).toBe('daily'); // Wednesday
  });
});

function bar(tsUtc: string, o: number, h: number, l: number, c: number, v: number): Bar {
  return {
    symbol: 'SPY',
    tsUtc,
    openCents: cents(o),
    highCents: cents(h),
    lowCents: cents(l),
    closeCents: cents(c),
    volume: v,
  };
}

describe('aggregateDailyBars', () => {
  it('collapses regular-hours minutes per session and drops extended hours', () => {
    const daily = aggregateDailyBars(
      [
        bar('2025-01-02T13:00:00Z', 59_000, 59_010, 58_990, 59_000, 10), // 08:00 ET pre-market
        bar('2025-01-02T14:30:00Z', 59_100, 59_150, 59_050, 59_120, 100), // 09:30 ET open
        bar('2025-01-02T20:59:00Z', 59_300, 59_400, 59_290, 59_390, 200), // 15:59 ET
        bar('2025-01-02T21:30:00Z', 59_500, 59_600, 59_500, 59_600, 30), // 16:30 ET after-hours
        bar('2025-01-03T15:00:00Z', 59_200, 59_210, 59_190, 59_200, 50),
      ],
      MarketCalendar.nyse(),
    );

    expect(daily).toHaveLength(2);
    expect(daily[0]).toEqual({
      symbol: 'SPY',
      tsUtc: '2025-01-02T21:00:00.000Z', // session close, 16:00 ET
      openCents: 59_100 as Cents,
      highCents: 59_400 as Cents,
      lowCents: 59_050 as Cents,
      closeCents: 59_390 as Cents,
      volume: 300,
    });
    expect(daily[1]!.tsUtc).toBe('2025-01-03T21:00:00.000Z');
  });

  it('skips non-trading days entirely', () => {
    const daily = aggregateDailyBars(
      [bar('2025-01-01T15:00:00Z', 1, 1, 1, 1, 1)], // New Year's Day
      MarketCalendar.nyse(),
    );
    expect(daily).toEqual([]);
  });
});
