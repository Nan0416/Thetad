/**
 * Integration tests against the real Alpaca PAPER account.
 *
 * Credentials: ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY, from .env
 * locally or from GitHub Actions secrets in CI. Tests fail fast with a clear
 * message when they are missing.
 *
 * Order tests submit far-from-market limit orders (unfillable) on the paper
 * account and cancel them; unique client IDs keep concurrent CI runs from
 * colliding.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AlpacaBroker,
  AlpacaHttp,
  AlpacaMarketData,
  OccSymbol,
  cents,
  type Order,
} from '../src/index';

function loadCredentials(): { keyId: string; secretKey: string } {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env (CI) — env vars come from Actions secrets.
  }
  const keyId = process.env.ALPACA_PAPER_KEY_ID ?? '';
  const secretKey = process.env.ALPACA_PAPER_SECRET_KEY ?? '';
  if (!keyId || !secretKey) {
    throw new Error(
      'integ tests need ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY (via .env or CI secrets)',
    );
  }
  return { keyId, secretKey };
}

let broker: AlpacaBroker;
let marketData: AlpacaMarketData;

beforeAll(() => {
  const { keyId, secretKey } = loadCredentials();
  broker = new AlpacaBroker(
    new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://paper-api.alpaca.markets' }),
  );
  marketData = new AlpacaMarketData(
    new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://data.alpaca.markets' }),
  );
});

describe('alpaca paper account', () => {
  it('authenticates and meets the options-level requirement', async () => {
    const { account } = await broker.getAccount({});
    expect(Number.isSafeInteger(account.equityCents)).toBe(true);
    expect(account.equityCents).toBeGreaterThan(0);
    // The covered-strangle strategy needs Level 3 (spreads / covered shorts).
    expect(account.optionsLevel).toBeGreaterThanOrEqual(3);
  });

  it('lists positions in our shape', async () => {
    const { positions } = await broker.getPositions({});
    for (const position of positions) {
      expect(position.symbol).toBeTruthy();
      expect(Number.isFinite(position.qty)).toBe(true);
      expect(typeof position.isOption).toBe('boolean');
    }
  });
});

describe('alpaca market data', () => {
  it('fetches SPY daily bars as integer cents', async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 10 * 86_400_000);
    const { bars } = await marketData.getStockBars({
      symbol: 'SPY',
      timeframe: '1Day',
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    });
    expect(bars.length).toBeGreaterThanOrEqual(3);
    for (const bar of bars) {
      expect(Number.isSafeInteger(bar.closeCents)).toBe(true);
      expect(bar.highCents).toBeGreaterThanOrEqual(bar.lowCents);
      expect(Number.isNaN(Date.parse(bar.tsUtc))).toBe(false);
    }
  });

  it('fetches the SPY option chain with parseable OCC symbols and greeks', async () => {
    const { quotes } = await marketData.getOptionChain({ underlying: 'SPY' });
    const symbols = Object.keys(quotes);
    expect(symbols.length).toBeGreaterThan(100);
    for (const symbol of symbols.slice(0, 25)) {
      const parsed = OccSymbol.parse(symbol);
      expect(parsed.underlying).toBe('SPY');
      const quote = quotes[symbol]!;
      expect(Number.isSafeInteger(quote.bidCents)).toBe(true);
      expect(quote.askCents).toBeGreaterThanOrEqual(0);
    }
    const withGreeks = symbols.filter((s) => quotes[s]!.delta !== undefined);
    expect(withGreeks.length).toBeGreaterThan(0);
  });
});

describe('alpaca orders (unfillable, canceled)', () => {
  const ACTIVE_STATUSES = ['accepted', 'new', 'pending_new'];

  it('round-trips a single-leg limit order far below market', async () => {
    const { order } = await broker.submitOrder({
      order: {
        clientOrderId: `integ-single-${randomUUID()}`,
        legs: [{ symbol: 'SPY', side: 'buy', qty: 1 }],
        type: 'limit',
        limitPriceCents: cents(100), // $1.00 — never fills
        timeInForce: 'day',
      },
    });
    expect(ACTIVE_STATUSES).toContain(order.status);
    expect(order.filledQty).toBe(0);

    const { order: fetched } = await broker.getOrder({ orderId: order.id });
    expect(fetched.clientOrderId).toBe(order.clientOrderId);

    await broker.cancelOrder({ orderId: order.id });
  });

  it('round-trips a multi-leg put spread demanding an absurd credit', async () => {
    const { quotes } = await marketData.getOptionChain({ underlying: 'SPY' });
    // The chain can still list a contract that expired earlier today; ordering
    // against it is rejected as inactive, so keep only still-tradeable puts.
    const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const puts = Object.keys(quotes)
      .filter((s) => /P\d{8}$/.test(s) && OccSymbol.parse(s).expirationIso > todayIso)
      .sort();
    expect(puts.length).toBeGreaterThanOrEqual(2);

    let order: Order | undefined;
    try {
      ({ order } = await broker.submitOrder({
        order: {
          clientOrderId: `integ-mleg-${randomUUID()}`,
          legs: [
            { symbol: puts[1]!, side: 'sell', qty: 1 },
            { symbol: puts[0]!, side: 'buy', qty: 1 },
          ],
          type: 'limit',
          limitPriceCents: cents(-9_900), // demand a $99.00 credit — never fills
          timeInForce: 'day',
        },
      }));
      expect(ACTIVE_STATUSES).toContain(order.status);
    } finally {
      if (order) await broker.cancelOrder({ orderId: order.id });
    }
  });
});
