/**
 * Preload one symbol-year of 1-minute stock bars into
 * data/stock-minute-bars/<SYMBOL>-<year>.json — the same cache the
 * backtester will read for intraday work; preloading just front-runs the
 * fetch. Bars include extended hours as served by Alpaca (SIP feed,
 * split-adjusted); filter by session via MarketCalendar when consuming.
 *
 * Usage: npm run fetch:bars -- SPY 2025 [--force]
 */
import { AlpacaDataProvider, AlpacaHttp, DataCatalog, FredDataProvider } from '@thetad/engine';

process.loadEnvFile('.env');
const keyId = process.env.ALPACA_PAPER_KEY_ID ?? '';
const secretKey = process.env.ALPACA_PAPER_SECRET_KEY ?? '';
const fredApiKey = process.env.FRED_API_KEY ?? '';
if (!keyId || !secretKey) {
  console.error('missing ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY in .env');
  process.exit(1);
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const symbol = positional[0];
const year = Number(positional[1]);
const force = process.argv.includes('--force');
if (!symbol || !Number.isInteger(year)) {
  console.error('usage: npm run fetch:bars -- <SYMBOL> <year> [--force]');
  process.exit(2);
}

const catalog = new DataCatalog({
  provider: new AlpacaDataProvider({
    dataHttp: new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://data.alpaca.markets' }),
    tradingHttp: new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://paper-api.alpaca.markets' }),
  }),
  fredProvider: new FredDataProvider({ apiKey: fredApiKey }),
});

const snapshot = await catalog.getStockMinuteBarsRaw(symbol, year, force);
const days = new Set(snapshot.bars.map(([t]) => t.slice(0, 10)));
console.log(
  `${snapshot.symbol} ${snapshot.year}: ${snapshot.bars.length} one-minute bars across ` +
    `${days.size} days (fetched ${snapshot.fetchedAtUtc})`,
);
console.log(`cache: data/stock-minute-bars/${snapshot.symbol}-${snapshot.year}.json`);
