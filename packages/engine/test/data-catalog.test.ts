import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DataCatalog, nearestStrikeCents } from '../src/data/catalog/data-catalog';
import { AlpacaDataProvider } from '../src/data/providers/alpaca/data-provider';
import { FredDataProvider } from '../src/data/providers/fred/data-provider';
import { AlpacaHttp } from '../src/data/providers/alpaca/http';
import { cents } from '../src/core/money';

const EXPIRED_OCC = 'SPY240719P00520000';

function contract(type: 'put' | 'call', expiration: string, strike: string) {
  return {
    symbol: `SPY-${expiration}-${type}-${strike}`,
    type,
    expiration_date: expiration,
    strike_price: strike,
  };
}

/** One fake Alpaca serving all three endpoints, with pagination each. */
function makeFakeFetch(counter: { calls: number }): typeof fetch {
  return (async (url: string | URL | Request) => {
    counter.calls++;
    const u = new URL(String(url));
    const page = u.searchParams.get('page_token');
    let body: unknown;
    if (u.pathname === '/v2/options/contracts') {
      const status = u.searchParams.get('status');
      if (status === 'inactive' && !page) {
        body = {
          option_contracts: [
            contract('put', '2025-06-20', '500'),
            contract('put', '2025-06-20', '407.5'),
            contract('call', '2025-06-20', '500'),
          ],
          next_page_token: 'p2',
        };
      } else if (status === 'inactive') {
        body = { option_contracts: [contract('put', '2025-06-20', '495')], next_page_token: null };
      } else {
        body = { option_contracts: [contract('put', '2025-12-19', '520')], next_page_token: null };
      }
    } else if (u.pathname.includes('/BIG/')) {
      // A year-scale payload, to prove range splicing survives ~10^5 bars.
      const bigYear = Number((u.searchParams.get('start') ?? '2025').slice(0, 4));
      const base = Date.UTC(bigYear, 0, 2);
      body = {
        bars: Array.from({ length: 80_000 }, (_, i) => ({
          t: new Date(base + i * 60_000).toISOString(),
          o: 1,
          h: 1,
          l: 1,
          c: 1,
          v: 1,
        })),
        next_page_token: null,
      };
    } else if (u.pathname.startsWith('/v2/stocks/') && u.searchParams.get('timeframe') === '1Day') {
      const dailyYear = (u.searchParams.get('start') ?? '2025').slice(0, 4);
      body = {
        bars: [
          { t: `${dailyYear}-01-02T21:00:00Z`, o: 500, h: 505, l: 495, c: 502, v: 9000 },
          { t: `${dailyYear}-01-03T21:00:00Z`, o: 502, h: 508, l: 501, c: 507, v: 8000 },
        ],
        next_page_token: null,
      };
    } else if (u.pathname.startsWith('/v2/stocks/')) {
      // Bars land on Jan 02 of whatever year was requested, so year-file
      // splicing (getStockMinuteBarsRange) is observable.
      const year = (u.searchParams.get('start') ?? '2025').slice(0, 4);
      body = page
        ? {
            bars: [
              { t: `${year}-01-02T14:31:00Z`, o: 500.25, h: 500.6, l: 500.1, c: 500.5, v: 1200 },
            ],
            next_page_token: null,
          }
        : {
            bars: [
              { t: `${year}-01-02T14:30:00Z`, o: 500.0, h: 500.4, l: 499.9, c: 500.25, v: 1500 },
            ],
            next_page_token: 'p2',
          };
    } else {
      // Single or comma-joined symbols; an EMPTY* underlying never traded.
      const occs = u.searchParams
        .get('symbols')!
        .split(',')
        .filter((occ) => !occ.startsWith('EMPTY'));
      body = page
        ? {
            bars: Object.fromEntries(
              occs.map((occ) => [
                occ,
                [{ t: '2024-06-03T13:31:00Z', o: 4.7, h: 4.75, l: 4.7, c: 4.72, v: 3 }],
              ]),
            ),
            next_page_token: null,
          }
        : {
            bars: Object.fromEntries(
              occs.map((occ) => [
                occ,
                [{ t: '2024-06-03T13:30:00Z', o: 4.67, h: 4.77, l: 4.67, c: 4.77, v: 2 }],
              ]),
            ),
            next_page_token: 'p2',
          };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

function makeCatalog(dir: string, counter: { calls: number }): DataCatalog {
  const http = new AlpacaHttp({
    keyId: 'k',
    secretKey: 's',
    baseUrl: 'https://example.test',
    fetchFn: makeFakeFetch(counter),
  });
  const provider = new AlpacaDataProvider({ dataHttp: http, tradingHttp: http });
  const fredProvider = new FredDataProvider({ apiKey: 'test', fetchFn: makeFakeFetch(counter) });
  return new DataCatalog({ provider, fredProvider, rootDir: dir });
}

describe('DataCatalog: contracts', () => {
  it('fetches both statuses, paginates, groups and sorts strikes as cents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    const snapshot = await makeCatalog(dir, counter).getContracts('spy', 2025);

    expect(snapshot.underlying).toBe('SPY');
    expect(counter.calls).toBe(3); // inactive p1 + p2 + active
    expect(snapshot.expirations['2025-06-20']).toEqual({
      putStrikesCents: [40_750, 49_500, 50_000],
      callStrikesCents: [50_000],
    });
  });

  it('serves the second load from the cache file without fetching', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    await makeCatalog(dir, counter).getContracts('SPY', 2025);
    const callsAfterFirst = counter.calls;

    // Fresh instance, same cache dir: tier 2, no network.
    const strikes = await makeCatalog(dir, counter).strikesCentsFor('SPY', '2025-06-20', 'P');
    expect(strikes).toEqual([40_750, 49_500, 50_000]);
    expect(counter.calls).toBe(callsAfterFirst);
  });

  it('returns null for unlisted expirations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const catalog = makeCatalog(dir, { calls: 0 });
    expect(await catalog.strikesCentsFor('SPY', '2025-06-21', 'P')).toBeNull();
  });

  it('serves a fresh current-year catalog but refreshes a stale one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    const currentYear = new Date().getUTCFullYear();
    await makeCatalog(dir, counter).getContracts('SPY', currentYear);
    const callsAfterFirst = counter.calls;

    // Fresh instance, fresh file: no fetch.
    await makeCatalog(dir, counter).getContracts('SPY', currentYear);
    expect(counter.calls).toBe(callsAfterFirst);

    // Older than 24h: the current year keeps listing weeklies, so refetch.
    stampStale(join(dir, 'options', `SPY-${currentYear}-contracts.json`));
    await makeCatalog(dir, counter).getContracts('SPY', currentYear);
    expect(counter.calls).toBe(callsAfterFirst * 2);
  });
});

/** Rewrite a cache file's fetchedAtUtc to 25h ago. */
function stampStale(path: string): void {
  const cached = JSON.parse(readFileSync(path, 'utf8')) as { fetchedAtUtc: string };
  writeFileSync(
    path,
    JSON.stringify({
      ...cached,
      fetchedAtUtc: new Date(Date.now() - 25 * 3_600_000).toISOString(),
    }),
  );
}

describe('DataCatalog: stock minute bars', () => {
  it('paginates, converts to integer cents, caches, force-refreshes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    const catalog = makeCatalog(dir, counter);

    const bars = await catalog.getStockMinuteBars('spy', 2025);
    expect(counter.calls).toBe(2);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toEqual({
      symbol: 'SPY',
      tsUtc: '2025-01-02T14:30:00Z',
      openCents: 50_000,
      highCents: 50_040,
      lowCents: 49_990,
      closeCents: 50_025,
      volume: 1500,
    });

    await catalog.getStockMinuteBars('SPY', 2025); // tier 1: memo
    expect(counter.calls).toBe(2);
    await catalog.getStockMinuteBars('SPY', 2025, true); // force: tier 3
    expect(counter.calls).toBe(4);
  });
});

describe('DataCatalog: stock minute bars range', () => {
  it('splices bars across year files, inclusive of both bounds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const catalog = makeCatalog(dir, { calls: 0 });

    const bars = await catalog.getStockMinuteBarsRange('spy', '2024-01-02', '2025-01-02');
    expect(bars.map((b) => b.tsUtc)).toEqual([
      '2024-01-02T14:30:00Z',
      '2024-01-02T14:31:00Z',
      '2025-01-02T14:30:00Z',
      '2025-01-02T14:31:00Z',
    ]);
    expect(bars[0]!.symbol).toBe('SPY');
  });

  it('filters out bars outside the range', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const catalog = makeCatalog(dir, { calls: 0 });
    expect(await catalog.getStockMinuteBarsRange('SPY', '2025-01-03', '2025-12-31')).toEqual([]);
  });

  it('splices a year-scale bar count without exhausting the call stack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const catalog = makeCatalog(dir, { calls: 0 });
    const bars = await catalog.getStockMinuteBarsRange('BIG', '2025-01-01', '2025-12-31');
    expect(bars).toHaveLength(80_000);
  });

  it('rejects malformed and backwards ranges', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const catalog = makeCatalog(dir, { calls: 0 });
    await expect(catalog.getStockMinuteBarsRange('SPY', '2025-1-2', '2025-01-03')).rejects.toThrow(
      /bad date/,
    );
    await expect(
      catalog.getStockMinuteBarsRange('SPY', '2025-01-03', '2025-01-02'),
    ).rejects.toThrow(/backwards/);
  });
});

describe('DataCatalog: stock daily bars', () => {
  it('splices daily bars across year files from their own cache tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const catalog = makeCatalog(dir, { calls: 0 });

    const bars = await catalog.getStockDailyBarsRange('spy', '2024-01-02', '2025-01-02');
    expect(bars.map((b) => b.tsUtc)).toEqual([
      '2024-01-02T21:00:00Z',
      '2024-01-03T21:00:00Z',
      '2025-01-02T21:00:00Z',
    ]);
    expect(bars[0]!.closeCents).toBe(50_200);
    expect(existsSync(join(dir, 'stock-daily-bars', 'SPY-2024.json'))).toBe(true);
  });

  it('refreshes a within-TTL current-year file that predates a needed session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    const currentYear = new Date().getUTCFullYear();
    const todayUtcIso = new Date().toISOString().slice(0, 10);
    const catalog = makeCatalog(dir, counter);
    await catalog.getStockDailyBarsRaw('SPY', currentYear); // fresh file, stamped now
    const callsAfterFirst = counter.calls;

    // Needs a session before the stamp's UTC day: cache is good enough.
    await makeCatalog(dir, counter).getStockDailyBarsRange(
      'SPY',
      `${currentYear}-01-02`,
      `${currentYear}-01-02`,
      `${currentYear}-01-02`,
    );
    expect(counter.calls).toBe(callsAfterFirst);

    // Needs today's session: a same-day fetch may predate the close, refetch.
    await makeCatalog(dir, counter).getStockDailyBarsRange(
      'SPY',
      `${currentYear}-01-02`,
      todayUtcIso,
      todayUtcIso,
    );
    expect(counter.calls).toBe(callsAfterFirst * 2);
  });

  it('treats past years as immutable but refreshes a stale current year', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    await makeCatalog(dir, counter).getStockDailyBarsRaw('SPY', 2024);
    const callsAfterFirst = counter.calls;

    // Fresh instance, past year: file tier serves it forever.
    await makeCatalog(dir, counter).getStockDailyBarsRaw('SPY', 2024);
    expect(counter.calls).toBe(callsAfterFirst);

    // A current-year file older than 24h falls through to the provider.
    const currentYear = new Date().getUTCFullYear();
    mkdirSync(join(dir, 'stock-daily-bars'), { recursive: true });
    writeFileSync(
      join(dir, 'stock-daily-bars', `SPY-${currentYear}.json`),
      JSON.stringify({
        v: 1,
        symbol: 'SPY',
        year: currentYear,
        timeframe: '1Day',
        fetchedAtUtc: new Date(Date.now() - 25 * 3_600_000).toISOString(),
        bars: [],
      }),
    );
    const snapshot = await makeCatalog(dir, counter).getStockDailyBarsRaw('SPY', currentYear);
    expect(counter.calls).toBe(callsAfterFirst + 1);
    expect(snapshot.bars.length).toBeGreaterThan(0);
  });
});

describe('DataCatalog: option minute bars', () => {
  it('re-checks usability on the memo tier, so active contracts extend in-process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    const catalog = makeCatalog(dir, counter);
    const activeOcc = 'SPY991219P00520000'; // expires 2099: never complete
    await catalog.getOptionMinuteBarsRaw(activeOcc);
    const callsAfterFirst = counter.calls;

    await catalog.getOptionMinuteBarsRaw(activeOcc); // same instance: memo not usable
    expect(counter.calls).toBe(callsAfterFirst * 2);
  });

  it('fetches a contract life and treats expired contracts as immutable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    const bars = await makeCatalog(dir, counter).getOptionMinuteBars(EXPIRED_OCC);
    expect(bars).toHaveLength(2);
    expect(bars[0]!.closeCents).toBe(477);
    const callsAfterFirst = counter.calls;

    // Fresh instance: cache file is complete (expired), never refetches.
    await makeCatalog(dir, counter).getOptionMinuteBars(EXPIRED_OCC);
    expect(counter.calls).toBe(callsAfterFirst);
  });

  it('refetches still-active contracts whose cache is not complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    const activeOcc = 'SPY991219P00520000'; // expires 2099: never complete
    await makeCatalog(dir, counter).getOptionMinuteBarsRaw(activeOcc);
    const callsAfterFirst = counter.calls;

    await makeCatalog(dir, counter).getOptionMinuteBarsRaw(activeOcc);
    expect(counter.calls).toBe(callsAfterFirst * 2);
  });

  it('rejects malformed OCC symbols before any IO', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    await expect(makeCatalog(dir, counter).getOptionMinuteBars('nonsense')).rejects.toThrow(/OCC/);
    expect(counter.calls).toBe(0);
  });
});

describe('DataCatalog: option daily bars', () => {
  it('serves an open contract daily life for 24h, then refreshes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    const activeOcc = 'SPY991219P00520000'; // expires 2099: never complete
    await makeCatalog(dir, counter).getOptionDailyBars(activeOcc);
    const callsAfterFirst = counter.calls;

    // Fresh file: served across instances and by the bulk path, no fetch.
    await makeCatalog(dir, counter).getOptionDailyBars(activeOcc);
    expect(counter.calls).toBe(callsAfterFirst);
    const byOcc = await makeCatalog(dir, counter).getOptionDailyBarsBulk([activeOcc]);
    expect(counter.calls).toBe(callsAfterFirst);
    expect(byOcc.get(activeOcc)).toHaveLength(2);

    // Older than 24h: yesterday's session close may be missing, so refetch.
    stampStale(join(dir, 'option-daily-bars', `${activeOcc}.json`));
    await makeCatalog(dir, counter).getOptionDailyBars(activeOcc);
    expect(counter.calls).toBe(callsAfterFirst * 2);
  });

  it('bulk refreshes an open contract when the needed session postdates its coverage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    const activeOcc = 'SPY991219P00520000'; // expires 2099: never complete
    const todayUtcIso = new Date().toISOString().slice(0, 10);
    const yesterdayUtcIso = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await makeCatalog(dir, counter).getOptionDailyBarsBulk([activeOcc]);
    const callsAfterFirst = counter.calls; // file now fetched through today (UTC)

    // Yesterday's session is inside the coverage: served from the file.
    await makeCatalog(dir, counter).getOptionDailyBarsBulk([activeOcc], yesterdayUtcIso);
    expect(counter.calls).toBe(callsAfterFirst);

    // Today's session may still be partial in a same-day fetch: refetch.
    await makeCatalog(dir, counter).getOptionDailyBarsBulk([activeOcc], todayUtcIso);
    expect(counter.calls).toBe(callsAfterFirst * 2);
  });

  it('caches native daily bars in their own tree, immutable once expired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    const bars = await makeCatalog(dir, counter).getOptionDailyBars(EXPIRED_OCC);
    expect(bars).toHaveLength(2);
    expect(existsSync(join(dir, 'option-daily-bars', `${EXPIRED_OCC}.json`))).toBe(true);
    expect(existsSync(join(dir, 'option-minute-bars', `${EXPIRED_OCC}.json`))).toBe(false);
    const callsAfterFirst = counter.calls;

    // Fresh instance: complete (expired) daily file is served without refetch.
    await makeCatalog(dir, counter).getOptionDailyBars(EXPIRED_OCC);
    expect(counter.calls).toBe(callsAfterFirst);
  });
});

describe('DataCatalog: option daily bars bulk', () => {
  const OCC_PUT = 'SPY240719P00520000';
  const OCC_CALL = 'SPY240719C00520000';

  it('fetches all misses in one batched request cycle and caches per contract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    const byOcc = await makeCatalog(dir, counter).getOptionDailyBarsBulk([OCC_PUT, OCC_CALL]);

    expect(counter.calls).toBe(2); // one batch of two symbols, two pages
    expect(byOcc.get(OCC_PUT)).toHaveLength(2);
    expect(byOcc.get(OCC_CALL)!.map((b) => b.symbol)).toEqual([OCC_CALL, OCC_CALL]);
    expect(byOcc.get(OCC_PUT)![0]!.closeCents).toBe(477);
    expect(existsSync(join(dir, 'option-daily-bars', `${OCC_PUT}.json`))).toBe(true);
    expect(existsSync(join(dir, 'option-daily-bars', `${OCC_CALL}.json`))).toBe(true);

    // Fresh instance: both files are complete (expired), zero fetches.
    const counter2 = { calls: 0 };
    const again = await makeCatalog(dir, counter2).getOptionDailyBarsBulk([OCC_PUT, OCC_CALL]);
    expect(counter2.calls).toBe(0);
    expect(again.get(OCC_CALL)).toHaveLength(2);
  });

  it('serves cache hits from files and batches only the misses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    await makeCatalog(dir, counter).getOptionDailyBars(OCC_PUT); // single path writes the file
    const callsAfterSingle = counter.calls;

    const byOcc = await makeCatalog(dir, counter).getOptionDailyBarsBulk([OCC_PUT, OCC_CALL]);
    expect(counter.calls).toBe(callsAfterSingle + 2); // one batch for the call side only
    expect(byOcc.get(OCC_PUT)).toHaveLength(2);
    expect(byOcc.get(OCC_CALL)).toHaveLength(2);
  });

  it('caches an empty life for expired contracts that never traded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-cat-'));
    const counter = { calls: 0 };
    const neverTraded = 'EMPTY240719P00520000';
    const byOcc = await makeCatalog(dir, counter).getOptionDailyBarsBulk([neverTraded]);
    expect(byOcc.get(neverTraded)).toEqual([]);
    const callsAfterFirst = counter.calls;

    // The empty life is complete: a fresh instance never refetches it.
    await makeCatalog(dir, counter).getOptionDailyBarsBulk([neverTraded]);
    expect(counter.calls).toBe(callsAfterFirst);
  });
});

describe('nearestStrikeCents', () => {
  it('picks the closest listed strike', () => {
    const strikes = [cents(49_000), cents(50_000), cents(51_000)];
    expect(nearestStrikeCents(strikes, cents(50_260))).toBe(50_000);
    expect(nearestStrikeCents(strikes, cents(50_700))).toBe(51_000);
    expect(nearestStrikeCents([], cents(50_000))).toBeNull();
    expect(nearestStrikeCents(null, cents(50_000))).toBeNull();
  });
});
