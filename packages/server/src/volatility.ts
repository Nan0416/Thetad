import type { Bar, Cents, DataCatalog, RealizedVolPoint } from '@thetad/engine';
import {
  averageIv,
  calendarDaysBetween,
  cents,
  ExpirationClassifier,
  impliedVol,
  MarketCalendar,
  nearestExpirationToDte,
  nearestStrikeCents,
  OccSymbol,
  rollingRealizedVol,
} from '@thetad/engine';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * Volatility research endpoints. Realized vol comes straight from the daily
 * stock closes; the ATM implied-vol line is a constant ~30-day-maturity
 * series (nearest monthly expiration to 30 DTE, nearest strike to spot, the
 * put and call IVs averaged). Vols travel as decimals (0.18 = 18%).
 */

const DEFAULT_IV_DTE = 30;
/** Used only if the FRED rate series is unavailable (no API key / fetch fails). */
const FALLBACK_RATE = 0.04;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** Comma-separated day counts, e.g. "20,60"; deduped and sorted. Empty = no RV. */
const rvWindowsSchema = z
  .string()
  .optional()
  .transform((raw) => {
    const parsed = (raw ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 2 && n <= 250);
    return [...new Set(parsed)].sort((a, b) => a - b);
  });

const volatilityQuerySchema = z.object({
  symbol: z.string().regex(/^[A-Za-z]{1,6}$/, 'expected a stock symbol'),
  fromIso: isoDate,
  toIso: isoDate,
  ivDte: z.coerce.number().int().min(1).max(400).default(DEFAULT_IV_DTE),
  rvWindows: rvWindowsSchema,
});

const contractIvQuerySchema = z.object({
  fromIso: isoDate.optional(),
  toIso: isoDate.optional(),
  timeframe: z.enum(['1Min', '1Day']).default('1Day'),
});

type VolPair = readonly [string, number];

function isoDaysBefore(dateIso: string, days: number): string {
  return new Date(Date.parse(`${dateIso}T00:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Daily-close carry-forward lookup of DGS1MO (1-month T-bill), as a decimal. */
class RateLookup {
  private readonly points: readonly VolPair[];

  private constructor(points: readonly VolPair[]) {
    this.points = points;
  }

  static async load(catalog: DataCatalog, fromYear: number, toYear: number): Promise<RateLookup> {
    const points: VolPair[] = [];
    for (let year = fromYear; year <= toYear; year++) {
      try {
        const series = await catalog.getFredDailySeries('DGS1MO', year);
        for (const [dateIso, value] of series.observations) {
          if (value !== null) points.push([dateIso, value / 100]);
        }
      } catch {
        // No FRED key or fetch failed — the fallback rate covers this year.
      }
    }
    points.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return new RateLookup(points);
  }

  /** Most recent rate on or before `dateIso`; the fallback if none precedes it. */
  on(dateIso: string): number {
    let lo = 0;
    let hi = this.points.length - 1;
    let rate = FALLBACK_RATE;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid]![0] <= dateIso) {
        rate = this.points[mid]![1];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return rate;
  }
}

export function registerVolatilityRoutes(app: FastifyInstance, catalog: DataCatalog): void {
  const calendar = MarketCalendar.nyse();
  const classifier = new ExpirationClassifier(calendar);
  const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  /** Native daily closes for a contract, indexed by NY date; memoized per request. */
  async function dailyOptionCloses(
    occSymbol: string,
    memo: Map<string, ReadonlyMap<string, number>>,
  ): Promise<ReadonlyMap<string, number>> {
    const cached = memo.get(occSymbol);
    if (cached) return cached;
    const daily = await catalog.getOptionDailyBars(occSymbol);
    const byDate = new Map<string, number>(daily.map((b) => [b.tsUtc.slice(0, 10), b.closeCents]));
    memo.set(occSymbol, byDate);
    return byDate;
  }

  app.get('/api/research/volatility', async (request, reply) => {
    const query = volatilityQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.issues[0]!.message });
    const { symbol, fromIso, toIso, ivDte, rvWindows } = query.data;
    if (fromIso > toIso) return reply.code(400).send({ error: 'fromIso is after toIso' });

    // Prime the closes before the window so even the longest RV is defined
    // from day one (trading days -> calendar days, plus a weekend buffer).
    const primeDays = rvWindows.length > 0 ? Math.ceil(Math.max(...rvWindows) * 1.6) + 10 : 0;
    const primedFrom = isoDaysBefore(fromIso, primeDays);
    const dailyBars = await catalog.getStockDailyBarsRange(symbol, primedFrom, toIso);
    const closes = dailyBars.map((b) => ({ dateIso: b.tsUtc.slice(0, 10), close: b.closeCents }));

    const realized: Record<string, readonly VolPair[]> = {};
    for (const window of rvWindows) {
      realized[`window${window}`] = rollingRealizedVol(closes, window)
        .filter((p: RealizedVolPoint) => p.dateIso >= fromIso)
        .map((p) => [p.dateIso, p.vol] as VolPair);
    }

    const impliedAtm = await buildAtmIvSeries();
    const vix = await loadVix();

    return {
      symbol: symbol.toUpperCase(),
      fromIso,
      toIso,
      targetDte: ivDte,
      rvWindows,
      realized,
      impliedAtm,
      vix,
    };

    /** CBOE VIX (VIXCLS) over the window, as a decimal to match RV/IV. */
    async function loadVix(): Promise<readonly VolPair[]> {
      const out: VolPair[] = [];
      for (let year = Number(fromIso.slice(0, 4)); year <= Number(toIso.slice(0, 4)); year++) {
        try {
          const series = await catalog.getFredDailySeries('VIXCLS', year);
          for (const [dateIso, value] of series.observations) {
            if (value !== null && dateIso >= fromIso && dateIso <= toIso)
              out.push([dateIso, value / 100]);
          }
        } catch {
          // No FRED key / fetch failed — VIX overlay simply absent.
        }
      }
      return out;
    }

    async function buildAtmIvSeries(): Promise<readonly VolPair[]> {
      const upper = symbol.toUpperCase();
      const inWindow = dailyBars.filter((b) => b.tsUtc.slice(0, 10) >= fromIso);
      if (inWindow.length === 0) return [];

      // Monthly expirations across every year the window's ATM contracts reach.
      const today = todayIso();
      const years = new Set<number>();
      for (const bar of inWindow) years.add(Number(bar.tsUtc.slice(0, 4)) + 1); // exp ~1mo out may roll a year
      for (const bar of inWindow) years.add(Number(bar.tsUtc.slice(0, 4)));
      const monthlies: string[] = [];
      const strikesByExp = new Map<string, readonly Cents[]>();
      for (const year of [...years].sort()) {
        const { expirations } = await catalog.getContracts(upper, year);
        for (const [expirationIso, strikes] of Object.entries(expirations)) {
          if (safeClassify(expirationIso) !== 'monthly') continue;
          monthlies.push(expirationIso);
          strikesByExp.set(expirationIso, strikes.callStrikesCents as readonly Cents[]);
        }
      }

      const rates = await RateLookup.load(
        catalog,
        Number(primedFrom.slice(0, 4)),
        Number(toIso.slice(0, 4)),
      );
      const optionMemo = new Map<string, ReadonlyMap<string, number>>();
      const series: VolPair[] = [];

      for (const bar of inWindow) {
        const dateIso = bar.tsUtc.slice(0, 10);
        const expirationIso = nearestExpirationToDte(monthlies, dateIso, ivDte);
        // Skip once the target expiration is still open: no complete option history.
        if (!expirationIso || expirationIso >= today) continue;
        const strikes = strikesByExp.get(expirationIso);
        const strikeCents = nearestStrikeCents(strikes ?? null, cents(bar.closeCents));
        if (strikeCents === null) continue;

        const tYears = calendarDaysBetween(dateIso, expirationIso) / 365;
        const rate = rates.on(dateIso);
        const spot = bar.closeCents / 100;
        const strike = strikeCents / 100;

        const sides = await Promise.all(
          (['C', 'P'] as const).map(async (right) => {
            const occ = new OccSymbol(upper, expirationIso, right, strikeCents).toString();
            const price = (await dailyOptionCloses(occ, optionMemo)).get(dateIso);
            if (price === undefined) return null;
            return impliedVol(price / 100, { spot, strike, tYears, rate, right });
          }),
        );
        const iv = averageIv(sides[0] ?? null, sides[1] ?? null);
        if (iv !== null) series.push([dateIso, iv]);
      }
      return series;
    }

    function safeClassify(expirationIso: string): string | null {
      try {
        return classifier.classify(expirationIso);
      } catch {
        return null;
      }
    }
  });

  app.get('/api/research/contract-iv/:occ', async (request, reply) => {
    const query = contractIvQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: query.error.issues[0]!.message });
    let occ: OccSymbol;
    try {
      occ = OccSymbol.parse((request.params as { occ: string }).occ);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
    if (occ.expirationIso >= todayIso()) {
      return reply.code(400).send({ error: `contract not yet expired (${occ.expirationIso})` });
    }
    const { fromIso, toIso, timeframe } = query.data;

    const life =
      timeframe === '1Day'
        ? await catalog.getOptionDailyBars(occ.toString())
        : await catalog.getOptionMinuteBars(occ.toString());
    const optionBars = life.filter(
      (b) =>
        (!fromIso || b.tsUtc.slice(0, 10) >= fromIso) && (!toIso || b.tsUtc.slice(0, 10) <= toIso),
    );
    if (optionBars.length === 0) {
      return {
        occSymbol: occ.toString(),
        right: occ.right,
        strikeCents: occ.strikeCents,
        expirationIso: occ.expirationIso,
        timeframe,
        points: [] as VolPair[],
      };
    }

    const spanFrom = optionBars[0]!.tsUtc.slice(0, 10);
    const spanTo = optionBars[optionBars.length - 1]!.tsUtc.slice(0, 10);
    const rates = await RateLookup.load(
      catalog,
      Number(spanFrom.slice(0, 4)),
      Number(spanTo.slice(0, 4)),
    );

    // Spot aligned to the option bars: exact minute (1Min) or session date (1Day).
    const stockBars =
      timeframe === '1Day'
        ? await catalog.getStockDailyBarsRange(occ.underlying, spanFrom, spanTo)
        : await catalog.getStockMinuteBarsRange(occ.underlying, spanFrom, spanTo);
    const spotKey = (tsUtc: string) => (timeframe === '1Day' ? tsUtc.slice(0, 10) : tsUtc);
    const spotByKey = new Map<string, number>(
      stockBars.map((b) => [spotKey(b.tsUtc), b.closeCents]),
    );

    const strike = occ.strikeCents / 100;
    const points: VolPair[] = [];
    for (const bar of optionBars) {
      const spotCents = spotByKey.get(spotKey(bar.tsUtc));
      if (spotCents === undefined) continue;
      const dateIso = bar.tsUtc.slice(0, 10);
      const tYears = calendarDaysBetween(dateIso, occ.expirationIso) / 365;
      if (tYears <= 0) continue;
      const iv = impliedVol(bar.closeCents / 100, {
        spot: spotCents / 100,
        strike,
        tYears,
        rate: rates.on(dateIso),
        right: occ.right,
      });
      if (iv !== null) points.push([bar.tsUtc, iv]);
    }

    return {
      occSymbol: occ.toString(),
      right: occ.right,
      strikeCents: occ.strikeCents,
      expirationIso: occ.expirationIso,
      timeframe,
      points,
    };
  });
}
