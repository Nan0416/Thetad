/**
 * Preload the option contract catalog for one underlying-year into
 * data/options/<SYMBOL>-<year>-contracts.json — the same cache the
 * backtester reads (and populates on demand if missing). Preloading just
 * front-runs that fetch.
 *
 * Usage: npm run fetch:contracts -- SPY 2025 [--force]
 */
import { AlpacaHttp, DataCatalog } from '@thetad/engine';

process.loadEnvFile('.env');
const keyId = process.env.ALPACA_PAPER_KEY_ID ?? '';
const secretKey = process.env.ALPACA_PAPER_SECRET_KEY ?? '';
if (!keyId || !secretKey) {
  console.error('missing ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY in .env');
  process.exit(1);
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const underlying = positional[0];
const year = Number(positional[1]);
const force = process.argv.includes('--force');
if (!underlying || !Number.isInteger(year)) {
  console.error('usage: npm run fetch:contracts -- <SYMBOL> <year> [--force]');
  process.exit(2);
}

const catalog = new DataCatalog({
  dataHttp: new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://data.alpaca.markets' }),
  tradingHttp: new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://paper-api.alpaca.markets' }),
});

const snapshot = await catalog.getContracts(underlying, year, force);
const expirations = Object.keys(snapshot.expirations);
const puts = Object.values(snapshot.expirations).reduce((a, e) => a + e.putStrikesCents.length, 0);
const calls = Object.values(snapshot.expirations).reduce(
  (a, e) => a + e.callStrikesCents.length,
  0,
);
console.log(
  `${snapshot.underlying} ${snapshot.year}: ${expirations.length} expirations, ` +
    `${puts} puts, ${calls} calls (fetched ${snapshot.fetchedAtUtc})`,
);
console.log(`cache: data/options/${snapshot.underlying}-${snapshot.year}-contracts.json`);
