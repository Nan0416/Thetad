import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlpacaOptionMinuteBarStore } from '../src/backtest/option-minute-bar-store';
import { AlpacaHttp } from '../src/data/providers/alpaca/http';

const OCC = 'SPY240719P00520000'; // expired 2024-07-19

function makeFakeFetch(counter: { calls: number }): typeof fetch {
  return (async (url: string | URL | Request) => {
    counter.calls++;
    const page = new URL(String(url)).searchParams.get('page_token');
    const body = page
      ? {
          bars: {
            [OCC]: [{ t: '2024-06-03T13:31:00Z', o: 4.7, h: 4.75, l: 4.7, c: 4.72, v: 3 }],
          },
          next_page_token: null,
        }
      : {
          bars: {
            [OCC]: [{ t: '2024-06-03T13:30:00Z', o: 4.67, h: 4.77, l: 4.67, c: 4.77, v: 2 }],
          },
          next_page_token: 'p2',
        };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

function makeStore(dir: string, counter: { calls: number }): AlpacaOptionMinuteBarStore {
  const http = new AlpacaHttp({
    keyId: 'k',
    secretKey: 's',
    baseUrl: 'https://example.test',
    fetchFn: makeFakeFetch(counter),
  });
  return new AlpacaOptionMinuteBarStore(http, dir);
}

describe('AlpacaOptionMinuteBarStore', () => {
  it('paginates and converts prices to integer cents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-obars-'));
    const counter = { calls: 0 };
    const bars = await makeStore(dir, counter).getContract(OCC);

    expect(counter.calls).toBe(2);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toEqual({
      symbol: OCC,
      tsUtc: '2024-06-03T13:30:00Z',
      openCents: 467,
      highCents: 477,
      lowCents: 467,
      closeCents: 477,
      volume: 2,
    });
  });

  it('treats an expired contract as immutable: second load never fetches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-obars-'));
    const counter = { calls: 0 };
    await makeStore(dir, counter).getContract(OCC);
    const callsAfterFirst = counter.calls;

    const bars = await makeStore(dir, counter).getContract(OCC);
    expect(bars).toHaveLength(2);
    expect(counter.calls).toBe(callsAfterFirst);
  });

  it('rejects malformed OCC symbols before any IO', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thetad-obars-'));
    const counter = { calls: 0 };
    await expect(makeStore(dir, counter).getContract('nonsense')).rejects.toThrow(/OCC/);
    expect(counter.calls).toBe(0);
  });
});
