import { mkdtempSync } from 'node:fs';
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
    } else if (u.pathname.startsWith('/v2/stocks/')) {
      body = page
        ? {
            bars: [{ t: '2025-01-02T14:31:00Z', o: 500.25, h: 500.6, l: 500.1, c: 500.5, v: 1200 }],
            next_page_token: null,
          }
        : {
            bars: [{ t: '2025-01-02T14:30:00Z', o: 500.0, h: 500.4, l: 499.9, c: 500.25, v: 1500 }],
            next_page_token: 'p2',
          };
    } else {
      const occ = u.searchParams.get('symbols')!;
      body = page
        ? {
            bars: {
              [occ]: [{ t: '2024-06-03T13:31:00Z', o: 4.7, h: 4.75, l: 4.7, c: 4.72, v: 3 }],
            },
            next_page_token: null,
          }
        : {
            bars: {
              [occ]: [{ t: '2024-06-03T13:30:00Z', o: 4.67, h: 4.77, l: 4.67, c: 4.77, v: 2 }],
            },
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
});

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

describe('DataCatalog: option minute bars', () => {
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

describe('nearestStrikeCents', () => {
  it('picks the closest listed strike', () => {
    const strikes = [cents(49_000), cents(50_000), cents(51_000)];
    expect(nearestStrikeCents(strikes, cents(50_260))).toBe(50_000);
    expect(nearestStrikeCents(strikes, cents(50_700))).toBe(51_000);
    expect(nearestStrikeCents([], cents(50_000))).toBeNull();
    expect(nearestStrikeCents(null, cents(50_000))).toBeNull();
  });
});
