import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DataCatalog } from '../src/data/catalog/data-catalog';
import { MacroCalendar } from '../src/data/catalog/macro-calendar';
import { AlpacaDataProvider } from '../src/data/providers/alpaca/data-provider';
import { AlpacaHttp } from '../src/data/providers/alpaca/http';
import { FredDataProvider } from '../src/data/providers/fred/data-provider';

const THIS_YEAR = new Date().getUTCFullYear();

/** Fake FRED: release dates bounded by the realtime window; obs with a gap. */
function makeFredFetch(counter: { calls: number }): typeof fetch {
  return (async (url: string | URL | Request) => {
    counter.calls++;
    const u = new URL(String(url));
    let body: unknown;
    if (u.pathname === '/fred/release/dates') {
      const offset = Number(u.searchParams.get('offset'));
      const year = (u.searchParams.get('realtime_start') ?? '').slice(0, 4);
      body =
        offset === 0
          ? { release_dates: [{ date: `${year}-06-10` }, { date: `${year}-07-15` }] }
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

function makeFred(counter: { calls: number }): FredDataProvider {
  return new FredDataProvider({ apiKey: 'test', fetchFn: makeFredFetch(counter) });
}

function makeCalendar(dir: string, counter: { calls: number }): MacroCalendar {
  return new MacroCalendar({ fredProvider: makeFred(counter), rootDir: dir });
}

describe('MacroCalendar', () => {
  it('serves bundled FOMC decision days without any provider call', () => {
    const counter = { calls: 0 };
    const fomc = makeCalendar(mkdtempSync(join(tmpdir(), 'thetad-ref-')), counter).getFomcEvents();
    expect(fomc.length).toBe(32); // 2024-2027, 8 per year
    expect(fomc[0]).toEqual({ dateIso: '2024-01-31', event: 'FOMC', session: 'intraday' });
    expect(counter.calls).toBe(0);
  });

  it('partitions release dates by year and treats past years as immutable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-ref-'));
    const counter = { calls: 0 };
    const first = await makeCalendar(dir, counter).getReleaseDates('CPI', 2024);
    expect(first.release).toBe('CPI');
    expect(first.dates).toEqual(['2024-06-10', '2024-07-15']);
    const callsAfterFirst = counter.calls;

    // Fresh instance, same cache dir; even a stale fetchedAtUtc is fine for a past year.
    const path = join(dir, 'reference', 'release-dates-CPI-2024.json');
    const file = JSON.parse(readFileSync(path, 'utf8'));
    file.fetchedAtUtc = '2020-01-01T00:00:00.000Z';
    writeFileSync(path, JSON.stringify(file));
    const second = await makeCalendar(dir, counter).getReleaseDates('CPI', 2024);
    expect(second.dates).toEqual(first.dates);
    expect(counter.calls).toBe(callsAfterFirst);
  });

  it('auto-refreshes the current year once the cache is older than 24h', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-ref-'));
    const counter = { calls: 0 };
    await makeCalendar(dir, counter).getReleaseDates('CPI', THIS_YEAR);
    const callsAfterFirst = counter.calls;

    // Fresh cache: served from file, no fetch.
    await makeCalendar(dir, counter).getReleaseDates('CPI', THIS_YEAR);
    expect(counter.calls).toBe(callsAfterFirst);

    // Age the file beyond 24h: refetches.
    const path = join(dir, 'reference', `release-dates-CPI-${THIS_YEAR}.json`);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    file.fetchedAtUtc = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(file));
    await makeCalendar(dir, counter).getReleaseDates('CPI', THIS_YEAR);
    expect(counter.calls).toBe(callsAfterFirst * 2);
  });

  it('combines FOMC with FRED releases for a year range, sorted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-ref-'));
    const events = await makeCalendar(dir, { calls: 0 }).getMacroEvents(2024, 2025);

    expect(new Set(events.map((e) => e.event))).toEqual(new Set(['FOMC', 'CPI', 'NFP', 'PCE']));
    expect(events.filter((e) => e.event === 'FOMC').length).toBe(16); // range-filtered
    expect(events.find((e) => e.event === 'CPI')?.session).toBe('pre_open');
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.dateIso >= events[i - 1]!.dateIso).toBe(true);
    }
  });
});

describe('DataCatalog: FRED daily series', () => {
  it('converts FRED "." to null, partitioned by year', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-ref-'));
    const alpacaHttp = new AlpacaHttp({
      keyId: 'k',
      secretKey: 's',
      baseUrl: 'https://example.test',
      fetchFn: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    });
    const catalog = new DataCatalog({
      provider: new AlpacaDataProvider({ dataHttp: alpacaHttp, tradingHttp: alpacaHttp }),
      fredProvider: makeFred({ calls: 0 }),
      rootDir: dir,
    });
    const series = await catalog.getFredDailySeries('DGS1MO', 2026);
    expect(series.year).toBe(2026);
    expect(series.observations).toEqual([
      ['2026-07-01', 4.32],
      ['2026-07-04', null],
      ['2026-07-02', 4.35],
    ]);
  });
});
