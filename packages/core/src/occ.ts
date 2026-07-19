import { cents, type Cents } from './money';

export type OptionRight = 'C' | 'P';

/**
 * OCC-style option symbol as used by Alpaca (no root padding):
 * SPY261218C00600000 = SPY 2026-12-18 call, strike $600.000 (thousandths).
 */
export function buildOccSymbol(
  underlying: string,
  expirationIso: string,
  right: OptionRight,
  strikeCents: Cents,
): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expirationIso);
  if (!m) throw new Error(`bad expiration date: ${expirationIso}`);
  const yymmdd = m[1]!.slice(2) + m[2]! + m[3]!;
  const thousandths = String(strikeCents * 10).padStart(8, '0');
  return `${underlying.toUpperCase()}${yymmdd}${right}${thousandths}`;
}

export interface ParsedOcc {
  underlying: string;
  expirationIso: string;
  right: OptionRight;
  strikeCents: Cents;
}

export function parseOccSymbol(occ: string): ParsedOcc {
  const m = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(occ);
  if (!m) throw new Error(`bad OCC symbol: ${occ}`);
  const thousandths = Number(m[6]);
  if (thousandths % 10 !== 0) {
    throw new Error(`sub-cent strike not representable: ${occ}`);
  }
  return {
    underlying: m[1]!,
    expirationIso: `20${m[2]}-${m[3]}-${m[4]}`,
    right: m[5] as OptionRight,
    strikeCents: cents(thousandths / 10),
  };
}
