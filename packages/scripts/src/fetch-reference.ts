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

const currentYear = new Date().getUTCFullYear();
const years = Array.from({ length: currentYear - 2024 + 1 }, (_, i) => 2024 + i);
for (const seriesId of ['DGS1MO', 'VIXCLS'] as const) {
  let total = 0;
  let latest: readonly [string, number | null] | undefined;
  for (const year of years) {
    const series = await catalog.getFredDailySeries(seriesId, year, force);
    total += series.observations.length;
    latest = [...series.observations].reverse().find(([, v]) => v !== null) ?? latest;
  }
  console.log(
    `${seriesId}: ${total} observations across ${years[0]}-${currentYear}, ` +
      `latest = ${latest?.[1]} (${latest?.[0]})`,
  );
}
console.log('\ncache: data/reference/');
