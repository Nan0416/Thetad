import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlpacaMinuteBarStore } from '../src/backtest/minute-bar-store';
import { AlpacaHttp } from '../src/data/providers/alpaca/http';

/** Fake Alpaca: two pages of minute bars, then done. */
function makeFakeFetch(counter: { calls: number }): typeof fetch {
  return (async (url: string | URL | Request) => {
    counter.calls++;
    const page = new URL(String(url)).searchParams.get('page_token');
    const body = page
      ? {
          bars: [{ t: '2025-01-02T14:31:00Z', o: 500.25, h: 500.6, l: 500.1, c: 500.5, v: 1200 }],
          next_page_token: null,
        }
      : {
          bars: [{ t: '2025-01-02T14:30:00Z', o: 500.0, h: 500.4, l: 499.9, c: 500.25, v: 1500 }],
          next_page_token: 'p2',
        };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

function makeStore(dir: string, counter: { calls: number }): AlpacaMinuteBarStore {
  const http = new AlpacaHttp({
    keyId: 'k',
    secretKey: 's',
    baseUrl: 'https://example.test',
    fetchFn: makeFakeFetch(counter),
  });
  return new AlpacaMinuteBarStore(http, dir);
}

describe('AlpacaMinuteBarStore', () => {
  it('paginates and converts prices to integer cents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-bars-'));
    const counter = { calls: 0 };
    const bars = await makeStore(dir, counter).getYear('spy', 2025);

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
    expect(bars[1]!.openCents).toBe(50_025);
  });

  it('serves the second load from the cache file without fetching', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-bars-'));
    const counter = { calls: 0 };
    await makeStore(dir, counter).getYear('SPY', 2025);
    const callsAfterFirst = counter.calls;

    const bars = await makeStore(dir, counter).getYear('SPY', 2025);
    expect(bars).toHaveLength(2);
    expect(counter.calls).toBe(callsAfterFirst);
  });

  it('refetches with forceRefresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-bars-'));
    const counter = { calls: 0 };
    const store = makeStore(dir, counter);
    await store.getYear('SPY', 2025);
    const callsAfterFirst = counter.calls;
    await store.getYear('SPY', 2025, true);
    expect(counter.calls).toBe(callsAfterFirst * 2);
  });
});
