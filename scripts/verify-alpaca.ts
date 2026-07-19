/**
 * Contract test against the real Alpaca paper API: verifies our zod schemas
 * and request shapes for every endpoint thetad uses. Requires paper keys in
 * .env. Read-only by default; pass --orders to also round-trip orders
 * (submit far-from-market limit orders on the PAPER account, then cancel).
 *
 * Run: npm run verify:alpaca  |  npm run verify:alpaca -- --orders
 */
import { cents } from '@thetad/core';
import { AlpacaHttp, AlpacaMarketData } from '@thetad/data';
import { AlpacaBroker } from '@thetad/broker';

process.loadEnvFile('.env');
const keyId = process.env.ALPACA_PAPER_KEY_ID ?? '';
const secretKey = process.env.ALPACA_PAPER_SECRET_KEY ?? '';
if (!keyId || !secretKey) {
  console.error('missing ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY in .env');
  process.exit(1);
}

const withOrders = process.argv.includes('--orders');
const trading = new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://paper-api.alpaca.markets' });
const data = new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://data.alpaca.markets' });
const broker = new AlpacaBroker(trading);
const marketData = new AlpacaMarketData(data);

let failures = 0;
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    console.log(`ok   ${name}: ${await fn()}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${(error as Error).message}`);
  }
}

await check('account', async () => {
  const { account } = await broker.getAccount({});
  return `equity=${account.equityCents}c, buyingPower=${account.buyingPowerCents}c, optionsLevel=${account.optionsLevel}`;
});

await check('positions', async () => {
  const { positions } = await broker.getPositions({});
  return `${positions.length} open`;
});

await check('stock bars (SPY 1Day)', async () => {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86_400_000);
  const { bars } = await marketData.getStockBars({
    symbol: 'SPY',
    timeframe: '1Day',
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  });
  if (bars.length === 0) throw new Error('no bars returned');
  const last = bars[bars.length - 1]!;
  return `${bars.length} bars, last close=${last.closeCents}c @ ${last.tsUtc}`;
});

await check('option chain (SPY)', async () => {
  const { quotes } = await marketData.getOptionChain({ underlying: 'SPY' });
  const symbols = Object.keys(quotes);
  if (symbols.length === 0) throw new Error('empty chain');
  const withGreeks = symbols.filter((s) => quotes[s]!.delta !== undefined).length;
  return `${symbols.length} contracts, ${withGreeks} with greeks, e.g. ${symbols[0]}`;
});

if (withOrders) {
  await check('single-leg order round-trip (limit far below market)', async () => {
    const { order } = await broker.submitOrder({
      order: {
        clientOrderId: `verify-single-${Date.now()}`,
        legs: [{ symbol: 'SPY', side: 'buy', qty: 1 }],
        type: 'limit',
        limitPriceCents: cents(100), // $1.00 — never fills
        timeInForce: 'day',
      },
    });
    const { order: fetched } = await broker.getOrder({ orderId: order.id });
    await broker.cancelOrder({ orderId: order.id });
    return `submitted=${order.status}, fetched=${fetched.status}, canceled ok`;
  });

  await check('multi-leg order round-trip (put spread, absurd credit)', async () => {
    const { quotes } = await marketData.getOptionChain({ underlying: 'SPY' });
    const puts = Object.keys(quotes)
      .filter((s) => /P\d{8}$/.test(s))
      .sort();
    if (puts.length < 2) throw new Error('not enough puts in chain');
    const [long, short] = [puts[0]!, puts[1]!]; // adjacent low strikes
    const { order } = await broker.submitOrder({
      order: {
        clientOrderId: `verify-mleg-${Date.now()}`,
        legs: [
          { symbol: short, side: 'sell', qty: 1 },
          { symbol: long, side: 'buy', qty: 1 },
        ],
        type: 'limit',
        limitPriceCents: cents(-9900), // demand a $99.00 credit — never fills
        timeInForce: 'day',
      },
    });
    await broker.cancelOrder({ orderId: order.id });
    return `submitted=${order.status}, canceled ok`;
  });
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
