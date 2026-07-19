/**
 * Run the SPY short-put backtest against Alpaca historical data.
 *
 * Usage: npm run backtest -- [--start 2024-05-01] [--end 2026-07-17]
 *   [--dte-min 40] [--dte-max 50] [--delta 0.16] [--delta-tol 0.04]
 *   [--min-iv-rank 30] [--profit-pct 50] [--stop-pct 300] [--time-exit 21]
 *
 * Results print to stdout; the trade log also lands in data/backtests/.
 */
import {
  AlpacaDataProvider,
  AlpacaHistoricalData,
  AlpacaHttp,
  DataCatalog,
  MarketCalendar,
  appendJsonl,
  cents,
  formatReport,
  runShortPutBacktest,
  type ShortPutParams,
} from '@thetad/engine';

process.loadEnvFile('.env');
const keyId = process.env.ALPACA_PAPER_KEY_ID ?? '';
const secretKey = process.env.ALPACA_PAPER_SECRET_KEY ?? '';
if (!keyId || !secretKey) {
  console.error('missing ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY in .env');
  process.exit(1);
}

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const params: ShortPutParams = {
  underlying: 'SPY',
  dteMin: Number(flag('dte-min', '40')),
  dteMax: Number(flag('dte-max', '50')),
  targetDelta: Number(flag('delta', '0.16')),
  deltaTolerance: Number(flag('delta-tol', '0.04')),
  minIvRank: Number(flag('min-iv-rank', '30')),
  profitTargetBps: Number(flag('profit-pct', '50')) * 100,
  stopLossBps: Number(flag('stop-pct', '300')) * 100,
  timeExitDte: Number(flag('time-exit', '21')),
  slippageCents: cents(Number(flag('slippage-cents', '3'))),
  feePerContractCents: cents(Number(flag('fee-cents', '5'))),
  rate: Number(flag('rate', '0.045')),
  divYield: Number(flag('div-yield', '0.012')),
  ivRankLookbackDays: Number(flag('iv-lookback', '252')),
  ivRankMinObservations: Number(flag('iv-min-obs', '60')),
  startIso: flag('start', '2024-05-01'),
  endIso: flag('end', '2026-07-17'),
};

const http = new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://data.alpaca.markets' });
const dataSource = new AlpacaHistoricalData(http, './data/backtest-cache');
// The catalog shares its cache tree with the fetch:* preload scripts and
// fetches anything missing on demand.
const catalog = new DataCatalog({
  provider: new AlpacaDataProvider({
    dataHttp: http,
    tradingHttp: new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://paper-api.alpaca.markets' }),
  }),
});

console.log(`SPY short put ${params.startIso}..${params.endIso}`);
console.log(
  `  entry: ${params.dteMin}-${params.dteMax} DTE, |Δ|≈${params.targetDelta}, IV rank ≥ ${params.minIvRank}`,
);
console.log(
  `  exit: +${params.profitTargetBps / 100}% credit | cost ≥ ${params.stopLossBps / 100}% credit | DTE ≤ ${params.timeExitDte}`,
);
console.log('');

const result = await runShortPutBacktest(params, dataSource, MarketCalendar.nyse(), catalog);
console.log(formatReport(result.metrics, result.trades));

const outPath = `./data/backtests/spy-short-put-${params.startIso}-${params.endIso}.jsonl`;
for (const trade of result.trades) appendJsonl(outPath, trade);
console.log(`\ntrade log: ${outPath}`);
