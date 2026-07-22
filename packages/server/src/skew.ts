import type { Cents, DataCatalog, ExpirationFrequency, OptionRight } from '@thetad/engine';
import {
  buildStrikeGrid,
  calendarDaysBetween,
  capEvenly,
  cents,
  ExpirationClassifier,
  impliedVol,
  MarketCalendar,
  OccSymbol,
} from '@thetad/engine';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RateLookup } from './volatility';

/**
 * Volatility skew/smile endpoint: one past date, the chain across strikes
 * and expirations, each contract's implied vol inverted from its daily
 * close with the same recipe as the volatility page (spot = the stock's
 * daily close, rate = 1-month T-bill, t = calendar days / 365). Open
 * contracts are included — a past session's close is final data even for
 * a live contract, and the catalog keeps open contracts' daily files and
 * the current year's chain fresh within 24h.
 */

/** Alpaca's options-history floor — no bars exist before this. */
const MIN_DATE_ISO = '2024-02-01';
/** Grid caps: rows (strikes) and columns (expirations) the heatmap holds. */
const MAX_STRIKES = 41;
const MAX_EXPIRATIONS = 24;

const skewQuerySchema = z.object({
  symbol: z.string().regex(/^[A-Za-z]{1,6}$/, 'expected a stock symbol'),
  dateIso: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  /** Half-width of the strike window around spot, in percent. */
  moneynessPct: z.coerce.number().int().min(2).max(50).default(15),
  /** Expiration window, in calendar days after the research date. */
  maxDte: z.coerce.number().int().min(1).max(730).default(120),
  /** Daily listings are dropped by default — they'd crowd out the term axis. */
  includeDailies: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** Every listed strike in the window instead of the subsampled grid. */
  allStrikes: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** One heatmap cell: [callCloseCents, callIv, putCloseCents, putIv]. */
type SkewCell = readonly [number | null, number | null, number | null, number | null];

function isoDaysAfter(dateIso: string, days: number): string {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function registerSkewRoutes(app: FastifyInstance, catalog: DataCatalog): void {
  const calendar = MarketCalendar.nyse();
  const classifier = new ExpirationClassifier(calendar);
  const nyTodayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const classify = (expirationIso: string): ExpirationFrequency | null => {
    try {
      return classifier.classify(expirationIso);
    } catch {
      return null; // outside bundled calendar coverage
    }
  };

  app.get('/api/research/skew', async (request, reply) => {
    const query = skewQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.issues[0]!.message });
    const { dateIso, moneynessPct, maxDte, includeDailies, allStrikes } = query.data;
    const symbol = query.data.symbol.toUpperCase();
    const today = nyTodayIso();
    if (dateIso < MIN_DATE_ISO) {
      return reply.code(400).send({ error: `option history starts ${MIN_DATE_ISO}` });
    }
    if (dateIso >= today) {
      return reply
        .code(400)
        .send({ error: 'pick a past date — the surface reads that session’s final closes' });
    }

    // mustCover: a within-TTL cache file fetched before this session ended
    // (e.g. asking for yesterday the morning after) refreshes instead of
    // reporting the session missing.
    const spotBars = await catalog.getStockDailyBarsRange(symbol, dateIso, dateIso, dateIso);
    const spotCents = spotBars[0]?.closeCents;
    if (spotCents === undefined) {
      return reply
        .code(400)
        .send({ error: `no ${symbol} bars on ${dateIso} (weekend, holiday, or unknown symbol?)` });
    }

    // Expirations after the research date and inside the DTE window — open
    // ones included (their chains and daily bars carry the catalog's 24h
    // freshness rule instead of the expired-immutable one).
    const windowEndIso = isoDaysAfter(dateIso, maxDte);
    interface Column {
      readonly expirationIso: string;
      readonly frequency: ExpirationFrequency | null;
      readonly callStrikes: ReadonlySet<number>;
      readonly putStrikes: ReadonlySet<number>;
    }
    const eligible: Column[] = [];
    for (let year = Number(dateIso.slice(0, 4)); year <= Number(windowEndIso.slice(0, 4)); year++) {
      const { expirations } = await catalog.getContracts(symbol, year);
      for (const [expirationIso, strikes] of Object.entries(expirations)) {
        if (expirationIso <= dateIso || expirationIso > windowEndIso) continue;
        const frequency = classify(expirationIso);
        if (!includeDailies && frequency === 'daily') continue;
        eligible.push({
          expirationIso,
          frequency,
          callStrikes: new Set(strikes.callStrikesCents),
          putStrikes: new Set(strikes.putStrikesCents),
        });
      }
    }
    eligible.sort((a, b) => a.expirationIso.localeCompare(b.expirationIso));
    if (eligible.length === 0) {
      return reply.code(400).send({
        error: 'no expirations in the window — widen max DTE or include dailies',
      });
    }
    const columns = capEvenly(eligible, MAX_EXPIRATIONS);

    const strikeUnion = new Set<number>();
    for (const column of columns) {
      for (const strike of column.callStrikes) strikeUnion.add(strike);
      for (const strike of column.putStrikes) strikeUnion.add(strike);
    }
    const strikesCents = buildStrikeGrid({
      strikesCents: [...strikeUnion].map((strike) => cents(strike)),
      spotCents: cents(spotCents),
      windowBps: moneynessPct * 100,
      // "All" is still bounded by the moneyness window; the subsample cap
      // only applies to the default view.
      maxStrikes: allStrikes ? Number.MAX_SAFE_INTEGER : MAX_STRIKES,
    });
    if (strikesCents.length === 0) {
      return reply
        .code(400)
        .send({ error: `no strikes within ±${moneynessPct}% of spot — widen the window` });
    }

    const occFor = (expirationIso: string, right: OptionRight, strikeCents: Cents) =>
      new OccSymbol(symbol, expirationIso, right, strikeCents).toString();
    const wanted: string[] = [];
    for (const column of columns) {
      for (const strikeCents of strikesCents) {
        if (column.callStrikes.has(strikeCents))
          wanted.push(occFor(column.expirationIso, 'C', strikeCents));
        if (column.putStrikes.has(strikeCents))
          wanted.push(occFor(column.expirationIso, 'P', strikeCents));
      }
    }
    const barsByOcc = await catalog.getOptionDailyBarsBulk(wanted, dateIso);
    const closeOn = (occSymbol: string): number | null => {
      const bar = barsByOcc.get(occSymbol)?.find((b) => b.tsUtc.slice(0, 10) === dateIso);
      return bar ? bar.closeCents : null;
    };

    // Prior year too: early January sits before the year's first observation.
    const year = Number(dateIso.slice(0, 4));
    const rates = await RateLookup.load(catalog, year - 1, year);
    const rate = rates.on(dateIso);
    const spot = spotCents / 100;

    const grid: (SkewCell | null)[][] = strikesCents.map((strikeCents) =>
      columns.map((column) => {
        const tYears = calendarDaysBetween(dateIso, column.expirationIso) / 365;
        const side = (
          right: OptionRight,
          listed: boolean,
        ): readonly [number | null, number | null] => {
          if (!listed) return [null, null];
          const closeCents = closeOn(occFor(column.expirationIso, right, strikeCents));
          if (closeCents === null) return [null, null];
          const iv = impliedVol(closeCents / 100, {
            spot,
            strike: strikeCents / 100,
            tYears,
            rate,
            right,
          });
          return [closeCents, iv];
        };
        const [callClose, callIv] = side('C', column.callStrikes.has(strikeCents));
        const [putClose, putIv] = side('P', column.putStrikes.has(strikeCents));
        if (callClose === null && putClose === null) return null;
        return [callClose, callIv, putClose, putIv];
      }),
    );

    // Trim expirations and strikes whose whole line came back empty — mostly
    // contracts not yet listed on the research date (weeklies list only a
    // few weeks ahead), which would render as blank columns.
    const colHasData = columns.map((_, e) => grid.some((row) => row[e] !== null));
    const rowHasData = grid.map((row) => row.some((cell) => cell !== null));
    const untradedExpirations = colHasData.filter((used) => !used).length;
    const keptColumns = columns.filter((_, e) => colHasData[e]);
    if (keptColumns.length === 0) {
      return reply.code(400).send({
        error: `no contract in the window traded on ${dateIso} — widen it or move the date`,
      });
    }

    return {
      symbol,
      dateIso,
      spotCents,
      rate,
      moneynessPct,
      maxDte,
      expirations: keptColumns.map((column) => ({
        expirationIso: column.expirationIso,
        dte: calendarDaysBetween(dateIso, column.expirationIso),
        frequency: column.frequency,
      })),
      strikesCents: strikesCents.filter((_, s) => rowHasData[s]),
      grid: grid.filter((_, s) => rowHasData[s]).map((row) => row.filter((_, e) => colHasData[e])),
      droppedExpirations: eligible.length - columns.length,
      untradedExpirations,
    };
  });
}
