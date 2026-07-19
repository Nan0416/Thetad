import type { Bps, Cents } from './money';
import type { OptionRight } from './occ';

/** One option leg of a position. qty is in contracts; negative = short. */
export interface OptionLeg {
  readonly occSymbol: string;
  readonly qty: number;
  readonly right: OptionRight;
  readonly strikeCents: Cents;
  readonly expirationIso: string;
}

export type PositionKind = 'covered_strangle';
export type PositionStatus = 'open' | 'closing' | 'closed';

/**
 * The pre-committed plan, decided at entry. The engine only ever enforces
 * this; it never invents rules mid-trade.
 */
export interface PositionPlan {
  /** Close options at this fraction of entry credit captured, e.g. 5000 = 50%. */
  readonly profitTargetBps: Bps;
  /** Close when cost-to-close reaches this multiple of credit, e.g. 30000 = 3x. */
  readonly stopLossBps: Bps;
  /** Close/roll when calendar DTE of the nearest leg reaches this. */
  readonly timeExitDte: number;
  /** Keep net delta (in share-equivalents) inside this band. */
  readonly deltaBandShares: { readonly min: number; readonly max: number };
  /** Only evaluate delta adjustments within this many minutes of the close. */
  readonly adjustWindowMinutes: number;
  readonly maxRolls: number;
}

export interface Position {
  readonly id: string;
  readonly kind: PositionKind;
  readonly underlying: string;
  /** Shares of the underlying held as coverage + delta dial. */
  readonly shares: number;
  readonly legs: readonly OptionLeg[];
  /** Total premium received at entry (contracts x 100 x per-share price). */
  readonly entryCreditCents: Cents;
  readonly rollCount: number;
  readonly status: PositionStatus;
  /** From snapshot.asof at entry — never wall clock. */
  readonly openedAtUtc: string;
  readonly plan: PositionPlan;
}

export interface EquityQuote {
  readonly symbol: string;
  readonly bidCents: Cents;
  readonly askCents: Cents;
}

export interface OptionQuote {
  readonly occSymbol: string;
  readonly bidCents: Cents;
  readonly askCents: Cents;
  readonly delta?: number;
  readonly gamma?: number;
  readonly thetaPerDay?: number;
  readonly vegaPerPoint?: number;
  readonly iv?: number;
}

export interface Bar {
  readonly symbol: string;
  /** Bar close time, ISO UTC. A snapshot at T may only contain bars closing <= T. */
  readonly tsUtc: string;
  readonly openCents: Cents;
  readonly highCents: Cents;
  readonly lowCents: Cents;
  readonly closeCents: Cents;
  readonly volume: number;
}

/**
 * The world as of one instant. `asof` is the engine's ONLY source of time —
 * in backtest it is the replayed bar time, live it is stamped at assembly.
 */
export interface MarketSnapshot {
  readonly asof: Date;
  readonly equities: Readonly<Record<string, EquityQuote>>;
  readonly options: Readonly<Record<string, OptionQuote>>;
}

export interface PortfolioState {
  readonly positions: readonly Position[];
  readonly equityCents: Cents;
  readonly highWaterEquityCents: Cents;
  readonly killSwitch: boolean;
}

export type CloseReason = 'profit_target' | 'stop_loss' | 'time_exit' | 'event_exit' | 'risk_halt';

export type Intent =
  | { readonly type: 'close_options'; readonly positionId: string; readonly reason: CloseReason }
  | {
      readonly type: 'adjust_stock';
      readonly positionId: string;
      readonly underlying: string;
      readonly deltaShares: number;
    }
  | { readonly type: 'halt'; readonly reason: string };
