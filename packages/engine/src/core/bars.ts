import type { MarketCalendar } from './calendar';
import type { Cents } from './money';
import type { Bar } from './types';

/**
 * Collapse minute bars into one bar per NYSE session: regular-hours bars
 * only (extended-hours minutes are dropped), keyed by New York trading
 * date, stamped at the session close so date labels render on the right
 * day in any timezone.
 */
export function aggregateDailyBars(bars: readonly Bar[], calendar: MarketCalendar): readonly Bar[] {
  const byDay = new Map<string, Bar>();
  for (const bar of bars) {
    const asof = new Date(bar.tsUtc);
    if (!calendar.isMarketOpen(asof)) continue;
    const dateIso = calendar.nyDateOf(asof);
    const existing = byDay.get(dateIso);
    if (!existing) {
      const closeUtc = calendar.sessionForDay(dateIso)!.closeUtc.toISOString();
      byDay.set(dateIso, { ...bar, tsUtc: closeUtc });
    } else {
      byDay.set(dateIso, {
        ...existing,
        highCents: Math.max(existing.highCents, bar.highCents) as Cents,
        lowCents: Math.min(existing.lowCents, bar.lowCents) as Cents,
        closeCents: bar.closeCents,
        volume: existing.volume + bar.volume,
      });
    }
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, bar]) => bar);
}
