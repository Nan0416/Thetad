import type { Cents } from '../core/money';

/**
 * Everything the backtester needs from the outside world: daily closes for
 * the underlying and for option contracts. Marks are trade-based daily bar
 * closes (Alpaca has no historical options NBBO); days without trades are
 * simply absent from the maps.
 */
export interface HistoricalDataSource {
  /** dateIso -> close, ascending-date iteration order. */
  getUnderlyingCloses(
    symbol: string,
    startIso: string,
    endIso: string,
  ): Promise<ReadonlyMap<string, Cents>>;

  /** occSymbol -> (dateIso -> close). Symbols with no data are absent. */
  getOptionCloses(
    occSymbols: readonly string[],
    startIso: string,
    endIso: string,
  ): Promise<ReadonlyMap<string, ReadonlyMap<string, Cents>>>;
}
