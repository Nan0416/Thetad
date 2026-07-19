import { impliedVol, bsGreeks } from '../core/blackscholes';
import type { MarketCalendar } from '../core/calendar';
import { cents, toUsd, type Cents } from '../core/money';
import type { BacktestExitReason, ShortPutParams } from './types';

/**
 * Pure decision logic for the short-put strategy. No IO, no clock — fully
 * unit-testable with synthetic inputs, exactly like the live Evaluator.
 */

/**
 * Candidate expirations are Fridays (holiday-adjusted to the prior trading
 * day) whose calendar DTE lies in [dteMin, dteMax]; pick the one closest to
 * the window midpoint. Fridays only: deepest SPY liquidity.
 */
export function pickExpiration(
  entryDateIso: string,
  calendar: MarketCalendar,
  dteMin: number,
  dteMax: number,
): string | null {
  const candidates: { dateIso: string; dte: number }[] = [];
  for (let dte = dteMin; dte <= dteMax; dte++) {
    const dateIso = addDaysIso(entryDateIso, dte);
    if (isFriday(dateIso)) {
      const adjusted = calendar.isTradingDay(dateIso)
        ? dateIso
        : priorTradingDay(dateIso, calendar);
      const adjustedDte = diffDays(entryDateIso, adjusted);
      if (adjustedDte >= dteMin && adjustedDte <= dteMax) {
        candidates.push({ dateIso: adjusted, dte: adjustedDte });
      }
    }
  }
  if (candidates.length === 0) return null;
  const mid = (dteMin + dteMax) / 2;
  candidates.sort((a, b) => Math.abs(a.dte - mid) - Math.abs(b.dte - mid));
  return candidates[0]!.dateIso;
}

export interface StrikeCandidate {
  readonly strikeCents: Cents;
  readonly closeCents: Cents;
}

export interface StrikeSelection {
  readonly strikeCents: Cents;
  readonly iv: number;
  readonly delta: number;
}

/**
 * Solve IV and delta for each candidate from its bar close, then choose the
 * strike whose |delta| is closest to targetDelta; null if the best miss
 * exceeds deltaTolerance or nothing is solvable.
 */
export function pickStrike(
  candidates: readonly StrikeCandidate[],
  spotCents: Cents,
  tYears: number,
  params: ShortPutParams,
): StrikeSelection | null {
  let best: (StrikeSelection & { miss: number }) | null = null;
  for (const candidate of candidates) {
    const base = {
      spot: toUsd(spotCents),
      strike: toUsd(candidate.strikeCents),
      tYears,
      rate: params.rate,
      divYield: params.divYield,
      right: 'P' as const,
    };
    const iv = impliedVol(toUsd(candidate.closeCents), base);
    if (iv === null) continue;
    const { delta } = bsGreeks({ ...base, vol: iv });
    const miss = Math.abs(Math.abs(delta) - params.targetDelta);
    if (best === null || miss < best.miss) {
      best = { strikeCents: candidate.strikeCents, iv, delta, miss };
    }
  }
  if (best === null || best.miss > params.deltaTolerance) return null;
  return { strikeCents: best.strikeCents, iv: best.iv, delta: best.delta };
}

/**
 * Exit precedence: stop first (worst news wins), then profit, then time.
 * Stop and profit are mutually exclusive at one mark; profit-before-time
 * records a same-day double hit as the profit it economically is.
 */
export function evaluateBacktestExit(
  entryCreditCents: Cents,
  markCostCents: Cents,
  dte: number,
  params: ShortPutParams,
): BacktestExitReason | null {
  if (markCostCents * 10_000 >= params.stopLossBps * entryCreditCents) return 'stop_loss';
  const profit = entryCreditCents - markCostCents;
  if (profit * 10_000 >= params.profitTargetBps * entryCreditCents) return 'profit_target';
  if (dte <= params.timeExitDte) return 'time_exit';
  return null;
}

/** Fill for selling 1 contract at a bar close: (close - slippage) x 100 - fee. */
export function sellFillCents(closeCents: Cents, params: ShortPutParams): Cents {
  const perShare = Math.max(1, closeCents - params.slippageCents);
  return cents(perShare * 100 - params.feePerContractCents);
}

/** Cost of buying back 1 contract at a bar close: (close + slippage) x 100 + fee. */
export function buyFillCents(closeCents: Cents, params: ShortPutParams): Cents {
  return cents((closeCents + params.slippageCents) * 100 + params.feePerContractCents);
}

/** $1-spaced strike grid spanning [loFrac, hiFrac] x spot, rounded to dollars. */
export function strikeGrid(spotCents: Cents, loFrac: number, hiFrac: number): Cents[] {
  const lo = Math.round((spotCents * loFrac) / 100);
  const hi = Math.round((spotCents * hiFrac) / 100);
  const strikes: Cents[] = [];
  for (let dollars = lo; dollars <= hi; dollars++) strikes.push(cents(dollars * 100));
  return strikes;
}

function isFriday(dateIso: string): boolean {
  return new Date(`${dateIso}T00:00:00Z`).getUTCDay() === 5;
}

export function addDaysIso(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function diffDays(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000,
  );
}

function priorTradingDay(dateIso: string, calendar: MarketCalendar): string {
  let cursor = addDaysIso(dateIso, -1);
  while (!calendar.isTradingDay(cursor)) cursor = addDaysIso(cursor, -1);
  return cursor;
}
