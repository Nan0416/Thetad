import type { ContractRow } from '../components/contracts-table';
import { fmtUsd, occSymbolFor, type ContractsResponse } from './api';

/** A table row plus a lowercased haystack for the free-text filter. */
export type SearchableRow = ContractRow & { readonly search: string };

export const TABLE_CAP = 200;
/** Unfiltered, show this many strikes per expiration (see selectContractView). */
export const ATM_PER_EXPIRATION = 20;
/** Alpaca's contract-listing floor. */
export const MIN_CONTRACT_YEAR = 2024;

function searchText(row: ContractRow): string {
  const right = row.right === 'P' ? 'p put' : 'c call';
  return `${row.occSymbol} ${right} ${row.frequency ?? ''} ${row.expirationIso} ${fmtUsd(row.strikeCents)} ${row.strikeCents / 100}`.toLowerCase();
}

/**
 * Flatten catalog year-slices into table rows for every listed put and call
 * whose expiration is inside the window AND already expired (only complete
 * lives are researchable). Rows are sorted newest-expiration first. Returns
 * the count of hidden un-expired expirations for the caller to surface.
 */
export function buildContractRows(params: {
  readonly symbol: string;
  readonly contractYears: readonly ContractsResponse[];
  readonly fromIso: string;
  readonly toIso: string;
  readonly todayIso: string;
}): { readonly rows: readonly SearchableRow[]; readonly unexpiredCount: number } {
  const { symbol, contractYears, fromIso, toIso, todayIso } = params;
  const rows: SearchableRow[] = [];
  let unexpiredCount = 0;
  for (const yearContracts of contractYears) {
    for (const [expirationIso, strikes] of Object.entries(yearContracts.expirations)) {
      if (expirationIso < fromIso || expirationIso > toIso) continue;
      if (expirationIso >= todayIso) {
        unexpiredCount++;
        continue;
      }
      const frequency = yearContracts.frequencies[expirationIso] ?? null;
      for (const right of ['C', 'P'] as const) {
        const strikesCents = right === 'P' ? strikes.putStrikesCents : strikes.callStrikesCents;
        for (const strikeCents of strikesCents) {
          const row: ContractRow = {
            occSymbol: occSymbolFor(symbol, expirationIso, right, strikeCents),
            right,
            frequency,
            expirationIso,
            strikeCents,
          };
          rows.push({ ...row, search: searchText(row) });
        }
      }
    }
  }
  rows.sort(
    (a, b) =>
      b.expirationIso.localeCompare(a.expirationIso) ||
      a.strikeCents - b.strikeCents ||
      a.right.localeCompare(b.right),
  );
  return { rows, unexpiredCount };
}

/**
 * The table's visible slice. With a filter, an exact free-text match over all
 * rows. Without one, the strikes nearest `spotCents` for EACH expiration — a
 * single SPY chain runs 300+ strikes, so a flat list would bury every other
 * date behind one expiration.
 */
export function selectContractView(
  rows: readonly SearchableRow[],
  filter: string,
  spotCents: number,
): { readonly rows: readonly SearchableRow[]; readonly atmOnly: boolean } {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length > 0) {
    return {
      rows: rows.filter((row) => terms.every((term) => row.search.includes(term))),
      atmOnly: false,
    };
  }
  const byExpiration = new Map<string, SearchableRow[]>();
  for (const row of rows) {
    const chain = byExpiration.get(row.expirationIso);
    if (chain) chain.push(row);
    else byExpiration.set(row.expirationIso, [row]);
  }
  const view: SearchableRow[] = [];
  for (const chain of byExpiration.values()) {
    const nearest = [...chain]
      .sort((a, b) => Math.abs(a.strikeCents - spotCents) - Math.abs(b.strikeCents - spotCents))
      .slice(0, ATM_PER_EXPIRATION)
      .sort((a, b) => a.strikeCents - b.strikeCents || a.right.localeCompare(b.right));
    view.push(...nearest);
    if (view.length >= TABLE_CAP) break;
  }
  return { rows: view, atmOnly: true };
}
