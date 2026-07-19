import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlpacaHttp } from '../src/data/providers/alpaca/http';
import { AlpacaContractCatalog, nearestStrikeCents } from '../src/backtest/contract-catalog';
import { cents } from '../src/core/money';

function contract(type: 'put' | 'call', expiration: string, strike: string) {
  return {
    symbol: `SPY${expiration.slice(2).replaceAll('-', '')}${type === 'put' ? 'P' : 'C'}x`,
    type,
    expiration_date: expiration,
    strike_price: strike,
  };
}

/** Fake Alpaca: inactive pages twice (pagination), active returns one more. */
function makeFakeFetch(counter: { calls: number }): typeof fetch {
  return (async (url: string | URL | Request) => {
    counter.calls++;
    const u = new URL(String(url));
    const status = u.searchParams.get('status');
    const page = u.searchParams.get('page_token');
    let body: unknown;
    if (status === 'inactive' && !page) {
      body = {
        option_contracts: [
          contract('put', '2025-06-20', '500'),
          contract('put', '2025-06-20', '407.5'),
          contract('call', '2025-06-20', '500'),
        ],
        next_page_token: 'page2',
      };
    } else if (status === 'inactive') {
      body = { option_contracts: [contract('put', '2025-06-20', '495')], next_page_token: null };
    } else {
      body = { option_contracts: [contract('put', '2025-12-19', '520')], next_page_token: null };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

function makeCatalog(dir: string, counter: { calls: number }): AlpacaContractCatalog {
  const http = new AlpacaHttp({
    keyId: 'k',
    secretKey: 's',
    baseUrl: 'https://example.test',
    fetchFn: makeFakeFetch(counter),
  });
  return new AlpacaContractCatalog(http, dir);
}

describe('AlpacaContractCatalog', () => {
  it('fetches both statuses, paginates, groups and sorts strikes as cents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-catalog-'));
    const counter = { calls: 0 };
    const snapshot = await makeCatalog(dir, counter).getYear('spy', 2025);

    expect(snapshot.underlying).toBe('SPY');
    expect(counter.calls).toBe(3); // inactive p1 + inactive p2 + active
    expect(snapshot.expirations['2025-06-20']).toEqual({
      putStrikesCents: [40_750, 49_500, 50_000],
      callStrikesCents: [50_000],
    });
    expect(snapshot.expirations['2025-12-19']!.putStrikesCents).toEqual([52_000]);
  });

  it('serves the second load from the cache file without fetching', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-catalog-'));
    const counter = { calls: 0 };
    await makeCatalog(dir, counter).getYear('SPY', 2025);
    const callsAfterFirst = counter.calls;

    // Fresh instance, same cache dir: must not hit the network.
    const strikes = await makeCatalog(dir, counter).strikesCentsFor('SPY', '2025-06-20', 'P');
    expect(strikes).toEqual([40_750, 49_500, 50_000]);
    expect(counter.calls).toBe(callsAfterFirst);
  });

  it('returns null for unlisted expirations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-catalog-'));
    const catalog = makeCatalog(dir, { calls: 0 });
    expect(await catalog.strikesCentsFor('SPY', '2025-06-21', 'P')).toBeNull();
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
