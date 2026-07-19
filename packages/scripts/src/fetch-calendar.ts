/**
 * Overwrite packages/engine/src/core/data/nyse-calendar.json with broker-authoritative
 * data from Alpaca's GET /v2/calendar (needs valid keys in .env). Same output
 * shape as scripts/generate-calendar.ts — consumers never notice the swap.
 *
 * Run: npm run calendar:fetch
 */
import { writeFileSync } from 'node:fs';

process.loadEnvFile('.env');
const keyId = process.env.ALPACA_PAPER_KEY_ID;
const secretKey = process.env.ALPACA_PAPER_SECRET_KEY;
if (!keyId || !secretKey) {
  console.error('missing ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY in .env');
  process.exit(1);
}

const url = new URL('https://paper-api.alpaca.markets/v2/calendar');
url.searchParams.set('start', '2016-01-01');
url.searchParams.set('end', '2027-12-31');

const response = await fetch(url, {
  headers: { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secretKey },
});
if (!response.ok) {
  console.error(`alpaca calendar request failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const raw = (await response.json()) as { date: string; open: string; close: string }[];
const days = raw.map(({ date, open, close }) => ({ date, open, close }));

const out = new URL('../../engine/src/core/data/nyse-calendar.json', import.meta.url);
writeFileSync(out, `[\n${days.map((d) => JSON.stringify(d)).join(',\n')}\n]\n`);
console.log(`wrote ${days.length} trading days from Alpaca to ${out.pathname}`);
