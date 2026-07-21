import { describe, expect, it } from 'vitest';
import { MarketCalendar } from '../src/core/calendar';
import { ExpirationClassifier } from '../src/core/expirations';

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
