/**
 * All money in thetad is integer cents. Floats are only for Greeks/vol math.
 * Percentages are expressed in basis points (bps, 1/100 of a percent) so that
 * percentage math stays in integers too. Rounding happens in exactly one
 * place: `roundHalfAwayFromZero`.
 */

export type Cents = number & { readonly __brand: 'cents' };

/** Basis points: 10000 = 100%. */
export type Bps = number;

export function cents(n: number): Cents {
  if (!Number.isSafeInteger(n)) {
    throw new Error(`not an integer cent amount: ${n}`);
  }
  return n as Cents;
}

function roundHalfAwayFromZero(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

export function addCents(...xs: Cents[]): Cents {
  return cents(xs.reduce((a, b) => a + b, 0));
}

/** Multiply a cent amount by an integer quantity (shares, contracts). */
export function mulCents(c: Cents, qty: number): Cents {
  if (!Number.isSafeInteger(qty)) {
    throw new Error(`quantity must be an integer: ${qty}`);
  }
  return cents(c * qty);
}

/** bps of a cent amount, e.g. pctOfCents(40000, 5000) = 20000 (50% of $400). */
export function pctOfCents(c: Cents, bps: Bps): Cents {
  return cents(roundHalfAwayFromZero((c * bps) / 10_000));
}

/** Convert a decimal dollar amount (e.g. from an API) to cents. */
export function fromUsd(usd: number): Cents {
  return cents(roundHalfAwayFromZero(usd * 100));
}

export function toUsd(c: Cents): number {
  return c / 100;
}

export function formatUsd(c: Cents): string {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  const dollars = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars}.${rem}`;
}
