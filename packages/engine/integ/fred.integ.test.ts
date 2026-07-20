/**
 * Integration tests against the real FRED v1 API. FRED_API_KEY from .env
 * locally or Actions secrets in CI.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { FRED_RELEASE_IDS, FredDataProvider } from '../src/index';

let fred: FredDataProvider;

beforeAll(() => {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env (CI) — env vars come from Actions secrets.
  }
  const apiKey = process.env.FRED_API_KEY ?? '';
  if (!apiKey) throw new Error('integ tests need FRED_API_KEY (via .env or CI secrets)');
  fred = new FredDataProvider({ apiKey });
});

describe('fred v1 api', () => {
  it('serves CPI release dates including the forward schedule', async () => {
    const { dates } = await fred.getReleaseDates({ releaseId: FRED_RELEASE_IDS.CPI });
    expect(dates.length).toBeGreaterThan(900);
    const todayIso = new Date().toISOString().slice(0, 10);
    expect(dates.some((d) => d >= todayIso)).toBe(true);
    for (let i = 1; i < dates.length; i++) expect(dates[i]! >= dates[i - 1]!).toBe(true);
  });

  it('serves the DGS1MO risk-free series with plausible recent values', async () => {
    const { observations } = await fred.getSeriesObservations({
      seriesId: 'DGS1MO',
      observationStart: '2026-01-01',
    });
    expect(observations.length).toBeGreaterThan(50);
    const latest = [...observations].reverse().find((o) => o.value !== '.');
    expect(latest).toBeDefined();
    const rate = Number(latest!.value);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(10);
  });

  it('serves VIXCLS with plausible recent values', async () => {
    const { observations } = await fred.getSeriesObservations({
      seriesId: 'VIXCLS',
      observationStart: '2026-06-01',
    });
    const latest = [...observations].reverse().find((o) => o.value !== '.');
    const vix = Number(latest!.value);
    expect(vix).toBeGreaterThan(5);
    expect(vix).toBeLessThan(150);
  });
});
