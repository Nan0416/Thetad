import type { Bps, Cents } from '../core/money';

/** Parameters of the systematic SPY short-put strategy. */
export interface ShortPutParams {
  readonly underlying: string;
  /** Entry DTE window [dteMin, dteMax], calendar days. */
  readonly dteMin: number;
  readonly dteMax: number;
  /** Target |put delta| at entry, e.g. 0.16. */
  readonly targetDelta: number;
  /** Skip the day if no strike lands within this of targetDelta. */
  readonly deltaTolerance: number;
  /** Enter only when IV Rank (0-100) is at least this. */
  readonly minIvRank: number;
  /** Close when this fraction of the credit is captured, e.g. 5000 = 50%. */
  readonly profitTargetBps: Bps;
  /** Close when cost-to-close reaches this multiple of credit, e.g. 30000 = 3x. */
  readonly stopLossBps: Bps;
  /** Close when calendar DTE <= this. */
  readonly timeExitDte: number;
  /** Per-share slippage applied to each fill (bar closes carry no spread). */
  readonly slippageCents: Cents;
  /** Per-contract fee per fill (regulatory + commission). */
  readonly feePerContractCents: Cents;
  /** Risk-free rate and continuous dividend yield for IV/delta solving. */
  readonly rate: number;
  readonly divYield: number;
  /** IV Rank lookback (trading days) and minimum observations to trade. */
  readonly ivRankLookbackDays: number;
  readonly ivRankMinObservations: number;
  /** Backtest window (trading decisions; data warm-up extends further back). */
  readonly startIso: string;
  readonly endIso: string;
}

export interface OpenShortPut {
  readonly occSymbol: string;
  readonly strikeCents: Cents;
  readonly expirationIso: string;
  readonly entryDateIso: string;
  /** Net premium received for 1 contract after slippage and fees. */
  readonly entryCreditCents: Cents;
  readonly entryDelta: number;
  readonly entryIv: number;
  readonly entryIvRank: number;
  readonly entrySpotCents: Cents;
}

export type BacktestExitReason = 'profit_target' | 'stop_loss' | 'time_exit' | 'end_of_data';

export interface ClosedTrade extends OpenShortPut {
  readonly exitDateIso: string;
  readonly exitReason: BacktestExitReason;
  /** Cost to buy back 1 contract, including slippage and fees. */
  readonly exitCostCents: Cents;
  readonly pnlCents: Cents;
  readonly holdTradingDays: number;
}

export interface EquityPoint {
  readonly dateIso: string;
  /** Realized P&L plus open-position mark-to-market, in cents. */
  readonly equityCents: Cents;
  readonly ivRank: number | null;
  readonly inPosition: boolean;
}

export interface BacktestMetrics {
  readonly tradeCount: number;
  readonly totalPnlCents: Cents;
  readonly winRate: number;
  readonly avgWinCents: number;
  readonly avgLossCents: number;
  readonly expectancyCents: number;
  readonly maxDrawdownCents: Cents;
  readonly exitBreakdown: Readonly<Record<BacktestExitReason, number>>;
  readonly avgHoldTradingDays: number;
  /** Fraction of backtest days spent in a position. */
  readonly exposureRate: number;
  /** Fraction of flat days where the IV Rank filter blocked entry. */
  readonly filterBlockRate: number;
  /** Simple annualized return on cash-secured capital (max strike x 100). */
  readonly annualizedReturnPct: number;
}

export interface BacktestResult {
  readonly params: ShortPutParams;
  readonly trades: readonly ClosedTrade[];
  readonly equityCurve: readonly EquityPoint[];
  readonly metrics: BacktestMetrics;
}
