import { join } from 'node:path';
import { z } from 'zod';
import fomcDecisionDays from '../../core/data/fomc-decision-days.json';
import { FRED_RELEASE_IDS, type FredDataProvider } from '../providers/fred/data-provider';
import { TieredCache } from './tiered-cache';

/** Macro releases tracked for the event calendar (FRED-backed). */
export type MacroRelease = keyof typeof FRED_RELEASE_IDS;

export type MacroEventKind = 'FOMC' | MacroRelease;

export interface MacroEvent {
  readonly dateIso: string;
  readonly event: MacroEventKind;
  /** CPI/NFP/PCE drop 8:30am ET (last exit: prior close); FOMC is 2pm ET. */
  readonly session: 'pre_open' | 'intraday';
}

/** One year of release dates for one macro release. */
export interface ReleaseDates {
  readonly v: 1;
  readonly release: string;
  readonly releaseId: number;
  readonly year: number;
  readonly fetchedAtUtc: string;
  /** Ascending; the current year includes the scheduled forward calendar. */
  readonly dates: readonly string[];
}

const releaseDatesSchema = z.object({
  v: z.literal(1),
  release: z.string(),
  releaseId: z.number(),
  year: z.number(),
  fetchedAtUtc: z.string(),
  dates: z.array(z.string()),
});

const CURRENT_YEAR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface MacroCalendarOptions {
  readonly fredProvider: FredDataProvider;
  /** Root of the local cache tree (default ./data). */
  readonly rootDir?: string;
}

/**
 * The macro event calendar: FOMC decision days (bundled, hand-curated from
 * federalreserve.gov — deliberately independent of FRED, see the JSON's
 * provenance note) plus FRED release dates for CPI/NFP/PCE, cached per
 * release-year under data/reference/. Past years are immutable; the current
 * (and any future) year auto-refreshes when its cache file is older than
 * 24 hours, so the rolling forward schedule stays current without --force.
 */
export class MacroCalendar {
  private readonly cache = new TieredCache();
  private readonly fredProvider: FredDataProvider;
  private readonly rootDir: string;

  constructor(options: MacroCalendarOptions) {
    this.fredProvider = options.fredProvider;
    this.rootDir = options.rootDir ?? './data';
  }

  /** Bundled FOMC decision days (2pm ET statement); no provider involved. */
  getFomcEvents(): readonly MacroEvent[] {
    return fomcDecisionDays.decisionDays.map((dateIso) => ({
      dateIso,
      event: 'FOMC' as const,
      session: 'intraday' as const,
    }));
  }

  async getReleaseDates(release: MacroRelease, year: number): Promise<ReleaseDates> {
    const releaseId = FRED_RELEASE_IDS[release];
    const currentYear = new Date().getUTCFullYear();
    return this.cache.get({
      path: join(this.rootDir, 'reference', `release-dates-${release}-${year}.json`),
      schema: releaseDatesSchema as z.ZodType<ReleaseDates>,
      isUsable: (cached) =>
        year < currentYear ||
        Date.now() - Date.parse(cached.fetchedAtUtc) < CURRENT_YEAR_MAX_AGE_MS,
      fetch: async () => {
        const { dates } = await this.fredProvider.getReleaseDates({
          releaseId,
          realtimeStart: `${year}-01-01`,
          realtimeEnd: `${year}-12-31`,
        });
        return {
          v: 1 as const,
          release,
          releaseId,
          year,
          fetchedAtUtc: new Date().toISOString(),
          dates,
        };
      },
    });
  }

  /** FOMC + CPI/NFP/PCE events for [fromYear, toYear], sorted ascending. */
  async getMacroEvents(fromYear: number, toYear: number): Promise<readonly MacroEvent[]> {
    const events: MacroEvent[] = this.getFomcEvents().filter((e) => {
      const year = Number(e.dateIso.slice(0, 4));
      return year >= fromYear && year <= toYear;
    });
    for (const release of Object.keys(FRED_RELEASE_IDS) as MacroRelease[]) {
      for (let year = fromYear; year <= toYear; year++) {
        const { dates } = await this.getReleaseDates(release, year);
        events.push(
          ...dates.map((dateIso) => ({
            dateIso,
            event: release,
            session: 'pre_open' as const,
          })),
        );
      }
    }
    return events.sort((a, b) => (a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 : 0));
  }
}
