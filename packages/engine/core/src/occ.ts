import { cents, type Cents } from './money';

export type OptionRight = 'C' | 'P';

/**
 * OCC-style option symbol as used by Alpaca (no root padding):
 * SPY261218C00600000 = SPY 2026-12-18 call, strike $600.000 (thousandths).
 */
export class OccSymbol {
  constructor(
    readonly underlying: string,
    readonly expirationIso: string,
    readonly right: OptionRight,
    readonly strikeCents: Cents,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expirationIso)) {
      throw new Error(`bad expiration date: ${expirationIso}`);
    }
  }

  static parse(occ: string): OccSymbol {
    const m = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ);
    if (!m) throw new Error(`bad OCC symbol: ${occ}`);
    const thousandths = Number(m[6]);
    if (thousandths % 10 !== 0) {
      throw new Error(`sub-cent strike not representable: ${occ}`);
    }
    return new OccSymbol(
      m[1]!,
      `20${m[2]}-${m[3]}-${m[4]}`,
      m[5] as OptionRight,
      cents(thousandths / 10),
    );
  }

  toString(): string {
    const [y, m, d] = this.expirationIso.split('-') as [string, string, string];
    const thousandths = String(this.strikeCents * 10).padStart(8, '0');
    return `${this.underlying.toUpperCase()}${y.slice(2)}${m}${d}${this.right}${thousandths}`;
  }
}
