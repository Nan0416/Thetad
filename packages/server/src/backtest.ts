import type { DataCatalog, HistoricalDataSource, ShortPutParams } from '@thetad/engine';
import { cents, MarketCalendar, runShortPutBacktest } from '@thetad/engine';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * The systematic short put as a research endpoint: run the daily EOD
 * backtest over a parameter set and return the trades, equity curve, and
 * metrics for the web page to plot. Runs in-request by agreement (the
 * AGENTS.md child-process rule targets CPU-bound work; this is dominated
 * by awaited data fetches, so the daemon loop stays responsive — but a
 * cold window's first run can take minutes of wall clock).
 */

/** Alpaca's options-history floor — the IV rank series starts here. */
const MIN_DATE_ISO = '2024-02-01';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const backtestQuerySchema = z.object({
  underlying: z
    .string()
    .regex(/^[A-Za-z]{1,6}$/, 'expected a stock symbol')
    .default('SPY'),
  startIso: isoDate.default('2024-05-01'),
  endIso: isoDate.optional(),
  dteMin: z.coerce.number().int().min(1).max(365).default(40),
  dteMax: z.coerce.number().int().min(1).max(365).default(50),
  targetDelta: z.coerce.number().min(0.02).max(0.9).default(0.16),
  deltaTolerance: z.coerce.number().min(0.005).max(0.5).default(0.04),
  minIvRank: z.coerce.number().min(0).max(100).default(30),
  /** Percent of credit captured to take profit, e.g. 50. */
  profitPct: z.coerce.number().min(1).max(100).default(50),
  /** Cost-to-close as percent of credit to stop out, e.g. 300 = 3x. */
  stopPct: z.coerce.number().min(10).max(2000).default(300),
  timeExitDte: z.coerce.number().int().min(0).max(120).default(21),
  slippageCents: z.coerce.number().int().min(0).max(1000).default(3),
  feeCents: z.coerce.number().int().min(0).max(1000).default(5),
  ratePct: z.coerce.number().min(0).max(20).default(4.5),
  divYieldPct: z.coerce.number().min(0).max(10).default(1.2),
  ivLookback: z.coerce.number().int().min(30).max(756).default(252),
  ivMinObs: z.coerce.number().int().min(10).max(500).default(60),
});

export function registerBacktestRoutes(
  app: FastifyInstance,
  catalog: DataCatalog,
  dataSource: HistoricalDataSource,
): void {
  const calendar = MarketCalendar.nyse();
  const nyTodayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  app.get('/api/research/backtest/short-put', async (request, reply) => {
    const query = backtestQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.issues[0]!.message });
    const q = query.data;
    const today = nyTodayIso();
    const endIso = q.endIso ?? today;
    if (q.startIso < MIN_DATE_ISO) {
      return reply.code(400).send({ error: `option history starts ${MIN_DATE_ISO}` });
    }
    if (q.startIso >= endIso || endIso > today) {
      return reply.code(400).send({ error: `window must satisfy start < end <= ${today}` });
    }
    if (q.dteMin > q.dteMax) {
      return reply.code(400).send({ error: 'dteMin is above dteMax' });
    }

    const params: ShortPutParams = {
      underlying: q.underlying.toUpperCase(),
      dteMin: q.dteMin,
      dteMax: q.dteMax,
      targetDelta: q.targetDelta,
      deltaTolerance: q.deltaTolerance,
      minIvRank: q.minIvRank,
      profitTargetBps: Math.round(q.profitPct * 100),
      stopLossBps: Math.round(q.stopPct * 100),
      timeExitDte: q.timeExitDte,
      slippageCents: cents(q.slippageCents),
      feePerContractCents: cents(q.feeCents),
      rate: q.ratePct / 100,
      divYield: q.divYieldPct / 100,
      ivRankLookbackDays: q.ivLookback,
      ivRankMinObservations: q.ivMinObs,
      startIso: q.startIso,
      endIso,
    };

    const result = await runShortPutBacktest(params, dataSource, calendar, catalog);
    return {
      params,
      metrics: result.metrics,
      trades: result.trades,
      /** Compact: [dateIso, equityCents, ivRank|null, inPosition 0|1]. */
      equityCurve: result.equityCurve.map((p) => [
        p.dateIso,
        p.equityCents,
        p.ivRank === null ? null : Math.round(p.ivRank * 10) / 10,
        p.inPosition ? 1 : 0,
      ]),
    };
  });
}
