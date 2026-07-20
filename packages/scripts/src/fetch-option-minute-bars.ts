/**
 * Preload one-minute option bars into data/option-minute-bars/<OCC>.json.
 * The backtester fetches these lazily per contract; this script exists for
 * testing and cache warm-up. Targets come from a backtest trade log (the
 * contracts a strategy actually held) or explicit OCC symbols.
 *
 * Usage:
 *   npm run fetch:option-bars -- --from-trades data/backtests/<run>.jsonl
 *   npm run fetch:option-bars -- SPY240719P00520000 [more symbols...]
 */
import {
  AlpacaDataProvider,
  AlpacaHttp,
  DataCatalog,
  FredDataProvider,
  readJsonl,
} from '@thetad/engine';

process.loadEnvFile('.env');
const keyId = process.env.ALPACA_PAPER_KEY_ID ?? '';
const secretKey = process.env.ALPACA_PAPER_SECRET_KEY ?? '';
const fredApiKey = process.env.FRED_API_KEY ?? '';
if (!keyId || !secretKey) {
  console.error('missing ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY in .env');
  process.exit(1);
}

const args = process.argv.slice(2);
const fromTradesIndex = args.indexOf('--from-trades');
const occSymbols = new Set<string>();
if (fromTradesIndex >= 0) {
  const path = args[fromTradesIndex + 1];
  if (!path) {
    console.error('--from-trades requires a trade-log path');
    process.exit(2);
  }
  for (const record of readJsonl(path)) {
    const occ = (record as { occSymbol?: string }).occSymbol;
    if (occ) occSymbols.add(occ);
  }
} else {
  for (const arg of args.filter((a) => !a.startsWith('--'))) occSymbols.add(arg);
}
if (occSymbols.size === 0) {
  console.error(
    'usage: npm run fetch:option-bars -- --from-trades <trades.jsonl> | <OCC symbols...>',
  );
  process.exit(2);
}

const catalog = new DataCatalog({
  provider: new AlpacaDataProvider({
    dataHttp: new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://data.alpaca.markets' }),
    tradingHttp: new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://paper-api.alpaca.markets' }),
  }),
  fredProvider: new FredDataProvider({ apiKey: fredApiKey }),
});

let totalBars = 0;
for (const occ of [...occSymbols].sort()) {
  const snapshot = await catalog.getOptionMinuteBarsRaw(occ);
  totalBars += snapshot.bars.length;
  console.log(
    `${occ}: ${snapshot.bars.length} minute bars (through ${snapshot.fetchedThroughIso})`,
  );
}
console.log(
  `\n${occSymbols.size} contracts, ${totalBars} minute bars cached in data/option-minute-bars/`,
);
