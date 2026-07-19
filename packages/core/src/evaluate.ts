import { calendarDte, isMarketOpen, minutesToClose } from './calendar';
import { cents, type Cents } from './money';
import type { Intent, MarketSnapshot, OptionQuote, PortfolioState, Position } from './types';

/**
 * The heart of thetad: a pure function of (state, snapshot) -> intents.
 * Level-triggered — every rule is a predicate on current state, never on a
 * transition, so a missed tick can never miss a trigger. The same function
 * runs in backtest, paper, and live; only the snapshot source differs.
 *
 * No wall-clock, no randomness, no IO. Time comes from snapshot.asof only.
 */
export function evaluate(state: PortfolioState, snapshot: MarketSnapshot): Intent[] {
  if (state.killSwitch) return [];

  const intents: Intent[] = [];
  for (const position of state.positions) {
    if (position.status !== 'open') continue;
    intents.push(...evaluatePosition(position, snapshot));
  }
  return intents;
}

function midCents(quote: OptionQuote): Cents {
  return cents(Math.round((quote.bidCents + quote.askCents) / 2));
}

/** Cost to buy back all short legs at mid; null if any quote is missing (stale-data guard). */
export function costToCloseCents(position: Position, snapshot: MarketSnapshot): Cents | null {
  let total = 0;
  for (const leg of position.legs) {
    if (leg.qty >= 0) continue;
    const quote = snapshot.options[leg.occSymbol];
    if (!quote) return null;
    total += midCents(quote) * 100 * -leg.qty;
  }
  return cents(total);
}

/** Net delta in share-equivalents; null if any leg's delta is unavailable. */
export function netDeltaShares(position: Position, snapshot: MarketSnapshot): number | null {
  let delta = position.shares;
  for (const leg of position.legs) {
    const quote = snapshot.options[leg.occSymbol];
    if (quote?.delta === undefined) return null;
    delta += leg.qty * quote.delta * 100;
  }
  return Math.round(delta);
}

function nearestExpirationIso(position: Position): string {
  return position.legs.map((l) => l.expirationIso).sort()[0]!;
}

function evaluatePosition(position: Position, snapshot: MarketSnapshot): Intent[] {
  const { plan, entryCreditCents: credit } = position;
  const mark = costToCloseCents(position, snapshot);
  if (mark === null) return [];

  // Integer-only comparisons via cross-multiplication: profit/credit >= bps/10000.
  const profit = credit - mark;
  if (profit * 10_000 >= plan.profitTargetBps * credit) {
    return [{ type: 'close_options', positionId: position.id, reason: 'profit_target' }];
  }

  // NOTE: live engine should debounce stops (N consecutive breached ticks)
  // before acting — wide overnight quotes produce false marks.
  if (mark * 10_000 >= plan.stopLossBps * credit) {
    return [{ type: 'close_options', positionId: position.id, reason: 'stop_loss' }];
  }

  if (calendarDte(snapshot.asof, nearestExpirationIso(position)) <= plan.timeExitDte) {
    return [{ type: 'close_options', positionId: position.id, reason: 'time_exit' }];
  }

  return deltaAdjustment(position, snapshot);
}

function deltaAdjustment(position: Position, snapshot: MarketSnapshot): Intent[] {
  const { plan } = position;
  const mtc = minutesToClose(snapshot.asof);
  if (!isMarketOpen(snapshot.asof) || mtc === null || mtc > plan.adjustWindowMinutes) return [];

  const net = netDeltaShares(position, snapshot);
  if (net === null) return [];
  const { min, max } = plan.deltaBandShares;
  if (net >= min && net <= max) return [];

  // Shares are simultaneously the delta dial and the short calls' collateral:
  // never adjust below 100 shares per short call contract.
  const shortCalls = position.legs
    .filter((l) => l.right === 'C' && l.qty < 0)
    .reduce((n, l) => n - l.qty, 0);
  const floor = 100 * shortCalls;

  const target = Math.round((min + max) / 2);
  const desiredShares = Math.max(floor, position.shares + (target - net));
  const deltaShares = desiredShares - position.shares;
  if (deltaShares === 0) return [];

  return [
    { type: 'adjust_stock', positionId: position.id, underlying: position.underlying, deltaShares },
  ];
}
