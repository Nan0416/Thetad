import { describe, expect, it } from 'vitest';
import {
  annualizedVol,
  averageIv,
  calendarDaysBetween,
  nearestExpirationToDte,
  rollingRealizedVol,
  type DailyClose,
} from '../src/core/volatility';

describe('annualizedVol', () => {
  it('matches a hand-computed sample-stddev × √252', () => {
    // returns mean 0.006, sample var 0.0001675, stddev 0.0129422, ×√252.
    const vol = annualizedVol([0.02, -0.01, 0.015, -0.005, 0.01]);
    expect(vol).toBeCloseTo(0.20546, 4);
  });

  it('is zero for a constant return series', () => {
    expect(annualizedVol([0.01, 0.01, 0.01])).toBeCloseTo(0, 12);
  });

  it('rejects fewer than two returns', () => {
    expect(() => annualizedVol([0.01])).toThrow(/two returns/);
  });
});

describe('rollingRealizedVol', () => {
  const e = Math.exp(0.01);
  // Log returns alternate +0.01 / -0.01; five closes → four returns.
  const closes: DailyClose[] = [
    { dateIso: '2025-01-02', close: 100 },
    { dateIso: '2025-01-03', close: 100 * e },
    { dateIso: '2025-01-06', close: 100 },
    { dateIso: '2025-01-07', close: 100 * e },
    { dateIso: '2025-01-08', close: 100 },
  ];

  it('emits one point per full window, stamped at the window-closing date', () => {
    const points = rollingRealizedVol(closes, 4);
    expect(points).toHaveLength(1);
    expect(points[0]!.dateIso).toBe('2025-01-08');
    // stddev of [.01,-.01,.01,-.01] = √(0.0004/3); ×√252.
    expect(points[0]!.vol).toBeCloseTo(0.1833, 4);
  });

  it('slides the window forward one date at a time', () => {
    const points = rollingRealizedVol(closes, 2);
    expect(points.map((p) => p.dateIso)).toEqual(['2025-01-06', '2025-01-07', '2025-01-08']);
    // each 2-return window is [±.01, ∓.01]: stddev √0.0002, ×√252.
    expect(points[0]!.vol).toBeCloseTo(0.22449, 4);
  });

  it('rejects non-positive closes', () => {
    expect(() =>
      rollingRealizedVol(
        [
          { dateIso: '2025-01-02', close: 100 },
          { dateIso: '2025-01-03', close: 0 },
          { dateIso: '2025-01-06', close: 100 },
        ],
        2,
      ),
    ).toThrow(/positive/);
  });
});

describe('calendarDaysBetween', () => {
  it('counts whole days across a DST boundary', () => {
    expect(calendarDaysBetween('2025-03-01', '2025-03-31')).toBe(30);
    expect(calendarDaysBetween('2025-01-31', '2025-01-01')).toBe(-30);
  });
});

describe('nearestExpirationToDte', () => {
  const expirations = ['2025-01-17', '2025-01-31', '2025-02-21'];

  it('picks the expiration closest to the target DTE', () => {
    expect(nearestExpirationToDte(expirations, '2025-01-01', 30)).toBe('2025-01-31'); // exactly 30
    expect(nearestExpirationToDte(expirations, '2025-01-01', 16)).toBe('2025-01-17'); // exactly 16
  });

  it('ignores expirations that have already passed', () => {
    expect(nearestExpirationToDte(expirations, '2025-02-01', 30)).toBe('2025-02-21');
  });

  it('returns null when nothing is in the future', () => {
    expect(nearestExpirationToDte(expirations, '2025-03-01', 30)).toBeNull();
  });

  it('breaks ties toward the longer-dated expiration, regardless of input order', () => {
    // From 2025-06-01: 06-29 is 28 DTE, 07-03 is 32 DTE — both distance 2 from 30.
    expect(nearestExpirationToDte(['2025-06-29', '2025-07-03'], '2025-06-01', 30)).toBe(
      '2025-07-03',
    );
    expect(nearestExpirationToDte(['2025-07-03', '2025-06-29'], '2025-06-01', 30)).toBe(
      '2025-07-03',
    );
  });
});

describe('averageIv', () => {
  it('averages both sides when both are finite', () => {
    expect(averageIv(0.2, 0.24)).toBeCloseTo(0.22, 12);
  });

  it('falls back to the finite side', () => {
    expect(averageIv(null, 0.24)).toBe(0.24);
    expect(averageIv(0.2, null)).toBe(0.2);
  });

  it('is null when neither side resolves', () => {
    expect(averageIv(null, null)).toBeNull();
  });
});
