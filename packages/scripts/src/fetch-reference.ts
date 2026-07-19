/**
 * Preload the reference datasets into data/reference/: macro event calendar
 * (bundled FOMC + FRED release dates for CPI/NFP/PCE), the daily risk-free
 * rate series (DGS1MO), and daily VIX (VIXCLS). The backtester reads the
 * same cache and fetches on demand; the forward release schedule rolls, so
 * refresh with --force periodically.
 *
 * Usage: npm run fetch:reference [-- --force]
 */
import { AlpacaDataProvider, AlpacaHttp, DataCatalog, FredDataProvider } from '@thetad/engine';

process.loadEnvFile('.env');
const keyId = process.env.ALPACA_PAPER_KEY_ID ?? '';
const secretKey = process.env.ALPACA_PAPER_SECRET_KEY ?? '';
const fredApiKey = process.env.FRED_API_KEY ?? '';
if (!fredApiKey) {
  console.error('missing FRED_API_KEY in .env');
  process.exit(1);
}

const force = process.argv.includes('--force');
const catalog = new DataCatalog({
  provider: new AlpacaDataProvider({
    dataHttp: new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://data.alpaca.markets' }),
    tradingHttp: new AlpacaHttp({ keyId, secretKey, baseUrl: 'https://paper-api.alpaca.markets' }),
  }),
  fredProvider: new FredDataProvider({ apiKey: fredApiKey }),
});

const events = await catalog.getMacroEvents(force);
const todayIso = new Date().toISOString().slice(0, 10);
const upcoming = events.filter((e) => e.dateIso >= todayIso);
const byKind = new Map<string, number>();
for (const e of events) byKind.set(e.event, (byKind.get(e.event) ?? 0) + 1);
console.log(
  `macro events: ${events.length} total (${[...byKind].map(([k, n]) => `${k}=${n}`).join(', ')})`,
);
console.log(
  `  upcoming: ${upcoming
    .slice(0, 5)
    .map((e) => `${e.dateIso} ${e.event}`)
    .join(', ')} ...`,
);

for (const seriesId of ['DGS1MO', 'VIXCLS']) {
  const series = await catalog.getFredDailySeries(seriesId, force);
  const latest = [...series.observations].reverse().find(([, v]) => v !== null);
  console.log(
    `${seriesId}: ${series.observations.length} observations, ` +
      `${series.observations[0]?.[0]} .. ${series.observations[series.observations.length - 1]?.[0]}, ` +
      `latest = ${latest?.[1]} (${latest?.[0]})`,
  );
}
console.log('\ncache: data/reference/');
