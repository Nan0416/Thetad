import type { Bps } from './money';
import type { Intent, PortfolioState } from './types';

/**
 * Portfolio risk layer. Sits between the Evaluator and the order manager and
 * OUTRANKS position plans: it can veto risk-increasing intents but never
 * blocks a close. Account-level invariants only — it does not know or care
 * why any position exists.
 */
export interface RiskLimits {
  readonly maxOpenPositions: number;
  /** Drawdown from high-water equity that halts new risk, e.g. 1000 = 10%. */
  readonly haltDrawdownBps: Bps;
}

export interface RiskDecision {
  readonly allowed: readonly Intent[];
  readonly vetoed: readonly Intent[];
  readonly halted: boolean;
}

export class RiskManager {
  constructor(readonly limits: RiskLimits) {}

  apply(state: PortfolioState, intents: readonly Intent[]): RiskDecision {
    const drawdown = state.highWaterEquityCents - state.equityCents;
    const halted =
      state.killSwitch ||
      drawdown * 10_000 >= this.limits.haltDrawdownBps * state.highWaterEquityCents;

    const allowed: Intent[] = [];
    const vetoed: Intent[] = [];
    for (const intent of intents) {
      // Closes always pass — the risk layer must never trap the book in a position.
      if (intent.type === 'close_options' || intent.type === 'halt') {
        allowed.push(intent);
      } else if (halted) {
        vetoed.push(intent);
      } else {
        allowed.push(intent);
      }
    }
    if (halted && !state.killSwitch) {
      allowed.unshift({ type: 'halt', reason: 'drawdown limit breached' });
    }
    return { allowed, vetoed, halted };
  }
}
