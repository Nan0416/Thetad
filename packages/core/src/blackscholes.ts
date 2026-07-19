/**
 * Black-Scholes pricing and Greeks. Inputs/outputs are floats (these are
 * estimates, not ledger entries). Rates and vols are decimals (0.05, 0.20).
 */

import type { OptionRight } from './occ';

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function normPdf(x: number): number {
  return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
}

export interface BsInput {
  readonly spot: number;
  readonly strike: number;
  /** Annualized implied volatility as a decimal, e.g. 0.20. */
  readonly vol: number;
  /** Time to expiration in years. */
  readonly tYears: number;
  /** Annualized risk-free rate as a decimal. */
  readonly rate: number;
  readonly right: OptionRight;
}

function d1d2({ spot, strike, vol, tYears, rate }: BsInput): [number, number] {
  const sqrtT = Math.sqrt(tYears);
  const d1 = (Math.log(spot / strike) + (rate + (vol * vol) / 2) * tYears) / (vol * sqrtT);
  return [d1, d1 - vol * sqrtT];
}

export function bsPrice(input: BsInput): number {
  const { spot, strike, tYears, rate, right } = input;
  if (tYears <= 0) {
    return Math.max(right === 'C' ? spot - strike : strike - spot, 0);
  }
  const [d1, d2] = d1d2(input);
  const df = Math.exp(-rate * tYears);
  return right === 'C'
    ? spot * normCdf(d1) - strike * df * normCdf(d2)
    : strike * df * normCdf(-d2) - spot * normCdf(-d1);
}

export interface Greeks {
  readonly delta: number;
  /** Per $1 of spot move. */
  readonly gamma: number;
  /** Per calendar day. */
  readonly thetaPerDay: number;
  /** Per 1 vol point (0.01). */
  readonly vegaPerPoint: number;
}

export function bsGreeks(input: BsInput): Greeks {
  const { spot, strike, vol, tYears, rate, right } = input;
  if (tYears <= 0) {
    const itm = right === 'C' ? spot > strike : spot < strike;
    return { delta: itm ? (right === 'C' ? 1 : -1) : 0, gamma: 0, thetaPerDay: 0, vegaPerPoint: 0 };
  }
  const [d1, d2] = d1d2(input);
  const sqrtT = Math.sqrt(tYears);
  const df = Math.exp(-rate * tYears);
  const delta = right === 'C' ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = normPdf(d1) / (spot * vol * sqrtT);
  const thetaAnnual =
    (-spot * normPdf(d1) * vol) / (2 * sqrtT) -
    (right === 'C' ? rate * strike * df * normCdf(d2) : -rate * strike * df * normCdf(-d2));
  const vega = spot * normPdf(d1) * sqrtT;
  return {
    delta,
    gamma,
    thetaPerDay: thetaAnnual / 365,
    vegaPerPoint: vega / 100,
  };
}

/** Bisection IV solver; returns null if the price is outside no-arb bounds. */
export function impliedVol(
  price: number,
  input: Omit<BsInput, 'vol'>,
  tolerance = 1e-6,
): number | null {
  let lo = 1e-4;
  let hi = 5;
  if (price <= bsPrice({ ...input, vol: lo }) || price >= bsPrice({ ...input, vol: hi })) {
    return null;
  }
  for (let i = 0; i < 200 && hi - lo > tolerance; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice({ ...input, vol: mid }) < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
