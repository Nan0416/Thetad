import type { Bps, Cents } from './money';
import type { OptionRight } from './occ';

/** One option leg of a position. qty is in contracts; negative = short. */
export interface OptionLeg {
  occSymbol: string;
  qty: number;
  right: OptionRight;
  strikeCents: Cents;
  expirationIso: string;
}

export type PositionKind = 'covered_strangle';
export type PositionStatus = 'open' | 'closing' | 'closed';

/**
 * The pre-committed plan, decided at entry. The engine only ever enforces
 * this; it never invents rules mid-trade.
 */
export interface PositionPlan {
  /** Close options at this fraction of entry credit captured, e.g. 5000 = 50%. */
  profitTargetBps: Bps;
  /** Close when cost-to-close reaches this multiple of credit, e.g. 30000 = 3x. */
  stopLossBps: Bps;
  /** Close/roll when calendar DTE of the nearest leg reaches this. */
  timeExitDte: number;
  /** Keep net delta (in share-equivalents) inside this band. */
  deltaBandShares: { min: number; max: number };
  /** Only evaluate delta adjustments within this many minutes of the close. */
  adjustWindowMinutes: number;
  maxRolls: number;
}

export interface Position {
  id: string;
  kind: PositionKind;
  underlying: string;
  /** Shares of the underlying held as coverage + delta dial. */
  shares: number;
  legs: OptionLeg[];
  /** Total premium received at entry (contracts x 100 x per-share price). */
  entryCreditCents: Cents;
  rollCount: number;
  status: PositionStatus;
  /** From snapshot.asof at entry — never wall clock. */
  openedAtUtc: string;
  plan: PositionPlan;
}

export interface EquityQuote {
  symbol: string;
  bidCents: Cents;
  askCents: Cents;
}

export interface OptionQuote {
  occSymbol: string;
  bidCents: Cents;
  askCents: Cents;
  delta?: number;
  gamma?: number;
  thetaPerDay?: number;
  vegaPerPoint?: number;
  iv?: number;
}

export interface Bar {
  symbol: string;
  /** Bar close time, ISO UTC. A snapshot at T may only contain bars closing <= T. */
  tsUtc: string;
  openCents: Cents;
  highCents: Cents;
  lowCents: Cents;
  closeCents: Cents;
  volume: number;
}

/**
 * The world as of one instant. `asof` is the engine's ONLY source of time —
 * in backtest it is the replayed bar time, live it is stamped at assembly.
 */
export interface MarketSnapshot {
  asof: Date;
  equities: Record<string, EquityQuote>;
  options: Record<string, OptionQuote>;
}

export interface PortfolioState {
  positions: Position[];
  equityCents: Cents;
  highWaterEquityCents: Cents;
  killSwitch: boolean;
}

export type CloseReason = 'profit_target' | 'stop_loss' | 'time_exit' | 'event_exit' | 'risk_halt';

export type Intent =
  | { type: 'close_options'; positionId: string; reason: CloseReason }
  | { type: 'adjust_stock'; positionId: string; underlying: string; deltaShares: number }
  | { type: 'halt'; reason: string };
