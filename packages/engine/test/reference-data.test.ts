import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DataCatalog } from '../src/data/catalog/data-catalog';
import { AlpacaDataProvider } from '../src/data/providers/alpaca/data-provider';
import { AlpacaHttp } from '../src/data/providers/alpaca/http';
import { FredDataProvider } from '../src/data/providers/fred/data-provider';

/** Fake FRED: paginated release dates + observations with a missing value. */
function makeFredFetch(counter: { calls: number }): typeof fetch {
  return (async (url: string | URL | Request) => {
    counter.calls++;
    const u = new URL(String(url));
    let body: unknown;
    if (u.pathname === '/fred/release/dates') {
      // Exercise pagination: first page full (limit hacked via offset check).
      const offset = Number(u.searchParams.get('offset'));
      body =
        offset === 0
          ? { release_dates: [{ date: '2026-06-10' }, { date: '2026-07-15' }] }
          : { release_dates: [] };
    } else {
      body = {
        observations: [
          { date: '2026-07-01', value: '4.32' },
          { date: '2026-07-04', value: '.' },
          { date: '2026-07-02', value: '4.35' },
        ],
      };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

function makeCatalog(dir: string, counter: { calls: number }): DataCatalog {
  const alpacaHttp = new AlpacaHttp({
    keyId: 'k',
    secretKey: 's',
    baseUrl: 'https://example.test',
    fetchFn: (async () => new Response('{}', { status: 200 })) as typeof fetch,
  });
  return new DataCatalog({
    provider: new AlpacaDataProvider({ dataHttp: alpacaHttp, tradingHttp: alpacaHttp }),
    fredProvider: new FredDataProvider({ apiKey: 'test', fetchFn: makeFredFetch(counter) }),
    rootDir: dir,
  });
}

describe('DataCatalog: FRED reference data', () => {
  it('caches release dates and serves the second load without fetching', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-ref-'));
    const counter = { calls: 0 };
    const first = await makeCatalog(dir, counter).getReleaseDates('CPI');
    expect(first.releaseId).toBe(10);
    expect(first.dates).toEqual(['2026-06-10', '2026-07-15']);
    const callsAfterFirst = counter.calls;

    const second = await makeCatalog(dir, counter).getReleaseDates('CPI');
    expect(second.dates).toEqual(first.dates);
    expect(counter.calls).toBe(callsAfterFirst);
  });

  it('converts FRED "." to null in daily series', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-ref-'));
    const series = await makeCatalog(dir, { calls: 0 }).getFredDailySeries('DGS1MO', 2026);
    expect(series.observations).toEqual([
      ['2026-07-01', 4.32],
      ['2026-07-04', null],
      ['2026-07-02', 4.35],
    ]);
  });

  it('combines bundled FOMC with FRED releases into a sorted event calendar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-ref-'));
    const events = await makeCatalog(dir, { calls: 0 }).getMacroEvents();

    const kinds = new Set(events.map((e) => e.event));
    expect(kinds).toEqual(new Set(['FOMC', 'CPI', 'NFP', 'PCE']));
    // Bundled FOMC decision days present with intraday session
    const fomc = events.filter((e) => e.event === 'FOMC');
    expect(fomc.length).toBe(32); // 2024-2027, 8 per year
    expect(fomc[0]).toEqual({ dateIso: '2024-01-31', event: 'FOMC', session: 'intraday' });
    // FRED releases tagged pre_open
    expect(events.find((e) => e.event === 'CPI')?.session).toBe('pre_open');
    // Sorted ascending
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.dateIso >= events[i - 1]!.dateIso).toBe(true);
    }
  });
});
