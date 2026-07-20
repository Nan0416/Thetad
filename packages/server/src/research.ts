import type { Bar, DataCatalog, ExpirationFrequency, MinuteBarTuple } from '@thetad/engine';
import {
  aggregateDailyBars,
  ExpirationClassifier,
  MarketCalendar,
  OccSymbol,
} from '@thetad/engine';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * Read-only research endpoints over the DataCatalog. Historical/expired
 * data only: complete-life option bars are the catalog's completeness
 * guarantee, so unexpired contracts are refused rather than served partial.
 * Bars travel as compact tuples [tsUtc, o, h, l, c, v] in integer cents;
 * timeframe=1Day serves per-session aggregates of the cached minute bars.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const timeframe = z.enum(['1Min', '1Day']).default('1Min');

const contractsQuerySchema = z.object({
  underlying: z.string().regex(/^[A-Za-z]{1,6}$/, 'expected a stock symbol'),
  year: z.coerce.number().int().min(2000).max(2100),
});

const stockBarsQuerySchema = z.object({
  symbol: z.string().regex(/^[A-Za-z]{1,6}$/, 'expected a stock symbol'),
  fromIso: isoDate,
  toIso: isoDate,
  timeframe,
});

const optionBarsQuerySchema = z.object({
  fromIso: isoDate.optional(),
  toIso: isoDate.optional(),
  timeframe,
});

function toTuples(bars: readonly Bar[]): readonly MinuteBarTuple[] {
  return bars.map((b) => [b.tsUtc, b.openCents, b.highCents, b.lowCents, b.closeCents, b.volume]);
}

/** Today's date in New York, where expirations live. */
function nyTodayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export function registerResearchRoutes(app: FastifyInstance, catalog: DataCatalog): void {
  const calendar = MarketCalendar.nyse();
  const classifier = new ExpirationClassifier(calendar);

  const classify = (expirationIso: string): ExpirationFrequency | null => {
    try {
      return classifier.classify(expirationIso);
    } catch {
      return null; // outside bundled calendar coverage
    }
  };

  app.get('/api/research/contracts', async (request, reply) => {
    const query = contractsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.issues[0]!.message });
    const { underlying, year } = query.data;
    const { expirations } = await catalog.getContracts(underlying, year);
    const frequencies = Object.fromEntries(
      Object.keys(expirations).map((iso) => [iso, classify(iso)]),
    );
    return { underlying: underlying.toUpperCase(), year, expirations, frequencies };
  });

  app.get('/api/research/stock-bars', async (request, reply) => {
    const query = stockBarsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.issues[0]!.message });
    const { symbol, fromIso, toIso } = query.data;
    if (fromIso > toIso) return reply.code(400).send({ error: 'fromIso is after toIso' });
    // Daily bars are their own (much cheaper) provider dataset; only
    // option bars are aggregated from cached minutes.
    const bars =
      query.data.timeframe === '1Day'
        ? await catalog.getStockDailyBarsRange(symbol, fromIso, toIso)
        : await catalog.getStockMinuteBarsRange(symbol, fromIso, toIso);
    return {
      symbol: symbol.toUpperCase(),
      fromIso,
      toIso,
      timeframe: query.data.timeframe,
      bars: toTuples(bars),
    };
  });

  app.get('/api/research/option-bars/:occ', async (request, reply) => {
    const query = optionBarsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.issues[0]!.message });
    let occ: OccSymbol;
    try {
      occ = OccSymbol.parse((request.params as { occ: string }).occ);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
    if (occ.expirationIso >= nyTodayIso()) {
      return reply.code(400).send({
        error: `contract not yet expired (${occ.expirationIso}); research serves complete lives only`,
      });
    }
    const life = await catalog.getOptionMinuteBars(occ.toString());
    const { fromIso, toIso } = query.data;
    const inWindow = life.filter(
      (b) =>
        (!fromIso || b.tsUtc.slice(0, 10) >= fromIso) && (!toIso || b.tsUtc.slice(0, 10) <= toIso),
    );
    const bars =
      query.data.timeframe === '1Day' ? aggregateDailyBars(inWindow, calendar) : inWindow;
    return {
      occSymbol: occ.toString(),
      underlying: occ.underlying,
      expirationIso: occ.expirationIso,
      right: occ.right,
      strikeCents: occ.strikeCents,
      timeframe: query.data.timeframe,
      bars: toTuples(bars),
    };
  });
}
