import { describe, expect, it } from 'vitest';
import { MarketCalendar } from '../src/calendar';
import { Evaluator } from '../src/evaluator';
import { cents } from '../src/money';
import type { MarketSnapshot, PortfolioState, Position } from '../src/types';

const CALL = 'XYZ260918C00110000';
const PUT = 'XYZ260918P00090000';

const evaluator = new Evaluator(MarketCalendar.nyse());
const evaluate = (state: PortfolioState, snapshot: MarketSnapshot) =>
  evaluator.evaluate(state, snapshot);

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    kind: 'covered_strangle',
    underlying: 'XYZ',
    shares: 100,
    legs: [
      { occSymbol: CALL, qty: -1, right: 'C', strikeCents: cents(11_000), expirationIso: '2026-09-18' },
      { occSymbol: PUT, qty: -1, right: 'P', strikeCents: cents(9_000), expirationIso: '2026-09-18' },
    ],
    entryCreditCents: cents(40_000), // $4.00/share x 100 x 2 legs' worth of premium
    rollCount: 0,
    status: 'open',
    openedAtUtc: '2026-06-15T14:00:00Z',
    plan: {
      profitTargetBps: 5_000,
      stopLossBps: 30_000,
      timeExitDte: 21,
      deltaBandShares: { min: 40, max: 80 },
      adjustWindowMinutes: 30,
      maxRolls: 1,
    },
    ...overrides,
  };
}

function makeState(position: Position): PortfolioState {
  return {
    positions: [position],
    equityCents: cents(5_000_000),
    highWaterEquityCents: cents(5_000_000),
    killSwitch: false,
  };
}

interface QuoteSpec {
  midCents: number;
  delta?: number;
}

function makeSnapshot(asofIso: string, quotes: Record<string, QuoteSpec>): MarketSnapshot {
  const half = 10;
  const options = Object.fromEntries(
    Object.entries(quotes).map(([occ, spec]) => [
      occ,
      {
        occSymbol: occ,
        bidCents: cents(spec.midCents - half),
        askCents: cents(spec.midCents + half),
        ...(spec.delta !== undefined && { delta: spec.delta }),
      },
    ]),
  );
  return { asof: new Date(asofIso), equities: {}, options };
}

describe('evaluate: covered strangle lifecycle', () => {
  it('closes at the profit target', () => {
    // Credit $400 total; cost to close $150 -> 62.5% captured >= 50% target.
    const snapshot = makeSnapshot('2026-07-06T15:00:00Z', {
      [CALL]: { midCents: 100 },
      [PUT]: { midCents: 50 },
    });
    expect(evaluate(makeState(makePosition()), snapshot)).toEqual([
      { type: 'close_options', positionId: 'pos-1', reason: 'profit_target' },
    ]);
  });

  it('closes at the stop (cost-to-close >= 3x credit)', () => {
    const snapshot = makeSnapshot('2026-07-06T15:00:00Z', {
      [CALL]: { midCents: 800 },
      [PUT]: { midCents: 500 },
    });
    expect(evaluate(makeState(makePosition()), snapshot)).toEqual([
      { type: 'close_options', positionId: 'pos-1', reason: 'stop_loss' },
    ]);
  });

  it('closes at the 21-DTE time exit regardless of P&L', () => {
    const snapshot = makeSnapshot('2026-08-31T15:00:00Z', {
      [CALL]: { midCents: 160 },
      [PUT]: { midCents: 150 },
    });
    expect(evaluate(makeState(makePosition()), snapshot)).toEqual([
      { type: 'close_options', positionId: 'pos-1', reason: 'time_exit' },
    ]);
  });

  it('adjusts stock toward the delta band mid, only in the pre-close window', () => {
    const quotes = {
      [CALL]: { midCents: 160, delta: 0.85 },
      [PUT]: { midCents: 150, delta: -0.1 },
    };
    // net delta = 100 - 85 + 10 = 25, below band [40, 80] -> buy to midpoint 60.
    const preClose = makeSnapshot('2026-07-06T19:45:00Z', quotes);
    expect(evaluate(makeState(makePosition()), preClose)).toEqual([
      { type: 'adjust_stock', positionId: 'pos-1', underlying: 'XYZ', deltaShares: 35 },
    ]);

    const midday = makeSnapshot('2026-07-06T15:00:00Z', quotes);
    expect(evaluate(makeState(makePosition()), midday)).toEqual([]);
  });

  it('never sells shares below the covered-call collateral floor', () => {
    // net delta = 100 - 5 + 55 = 150, above band -> target 60 wants selling 90
    // shares, but the short call needs 100 shares of coverage.
    const snapshot = makeSnapshot('2026-07-06T19:45:00Z', {
      [CALL]: { midCents: 160, delta: 0.05 },
      [PUT]: { midCents: 150, delta: -0.55 },
    });
    expect(evaluate(makeState(makePosition()), snapshot)).toEqual([]);
  });

  it('does nothing on missing quotes (stale-data guard) or kill switch', () => {
    const missing = makeSnapshot('2026-07-06T15:00:00Z', { [CALL]: { midCents: 100 } });
    expect(evaluate(makeState(makePosition()), missing)).toEqual([]);

    const halted = { ...makeState(makePosition()), killSwitch: true };
    const snapshot = makeSnapshot('2026-07-06T15:00:00Z', {
      [CALL]: { midCents: 100 },
      [PUT]: { midCents: 50 },
    });
    expect(evaluate(halted, snapshot)).toEqual([]);
  });
});
