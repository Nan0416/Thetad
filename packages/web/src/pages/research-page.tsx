import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ContractsTable, type ContractRow } from '../components/contracts-table';
import { PayoffChart, type PayoffLeg } from '../components/payoff-chart';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  fetchContracts,
  fetchOptionBars,
  fetchStockBars,
  fmtUsd,
  isRegularHoursNy,
  type MinuteBarTuple,
  type OptionRight,
  type Timeframe,
} from '../lib/api';
import {
  ATM_PER_EXPIRATION,
  buildContractRows,
  MIN_CONTRACT_YEAR,
  selectContractView,
  TABLE_CAP,
  type SearchableRow,
} from '../lib/contracts';
import { useTheme } from '../theme';

interface Leg {
  readonly occSymbol: string;
  readonly underlying: string;
  readonly expirationIso: string;
  readonly right: OptionRight;
  readonly strikeCents: number;
  /** Categorical palette slot (1..7), claimed at add time and kept for life. */
  readonly slot: number;
  readonly bars: readonly MinuteBarTuple[];
}

interface View {
  readonly symbol: string;
  readonly fromIso: string;
  readonly toIso: string;
  readonly timeframe: Timeframe;
}

const MAX_LEGS = 7;

function isoDaysAgo(days: number, fromIso: string): string {
  return new Date(Date.parse(fromIso) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Above ~90 days of minutes, the chart and payloads want daily bars. */
function timeframeFor(fromIso: string, toIso: string): Timeframe {
  const days = (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000;
  return days > 90 ? '1Day' : '1Min';
}

export function ResearchPage() {
  const theme = useTheme();
  const todayIso = useMemo(
    () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    [],
  );

  const [symbolInput, setSymbolInput] = useState('SPY');
  const [graphFrom, setGraphFrom] = useState(isoDaysAgo(365, todayIso));
  const [graphTo, setGraphTo] = useState(todayIso);
  const [optionFrom, setOptionFrom] = useState(isoDaysAgo(365, todayIso));
  const [optionTo, setOptionTo] = useState(todayIso);
  const [view, setView] = useState<View | null>(null);
  const [stockBars, setStockBars] = useState<readonly MinuteBarTuple[]>([]);
  const [contractRows, setContractRows] = useState<readonly SearchableRow[]>([]);
  const [legs, setLegs] = useState<readonly Leg[]>([]);
  const [filter, setFilter] = useState('');
  const [unexpiredCount, setUnexpiredCount] = useState(0);
  const [rthOnly, setRthOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    const symbol = symbolInput.trim().toUpperCase();
    if (!/^[A-Z]{1,6}$/.test(symbol)) {
      setError('enter a stock symbol (1–6 letters)');
      return;
    }
    if (graphFrom > graphTo) {
      setError('graph window is backwards');
      return;
    }
    const timeframe = timeframeFor(graphFrom, graphTo);
    const nextView: View = { symbol, fromIso: graphFrom, toIso: graphTo, timeframe };
    const keptLegs = legs.filter((leg) => leg.underlying === symbol);
    setBusy(true);
    setError('');
    try {
      const fromYear = Math.max(MIN_CONTRACT_YEAR, Number(graphFrom.slice(0, 4)));
      const toYear = Math.max(fromYear, Number(graphTo.slice(0, 4)));
      const years = Array.from({ length: toYear - fromYear + 1 }, (_, i) => fromYear + i);
      const [stock, contractYears, refetchedLegs] = await Promise.all([
        fetchStockBars(symbol, graphFrom, graphTo, timeframe),
        Promise.all(years.map((year) => fetchContracts(symbol, year))),
        Promise.all(
          keptLegs.map(async (leg) => {
            const bars = await fetchOptionBars(leg.occSymbol, {
              fromIso: optionFrom,
              toIso: optionTo,
              timeframe,
            });
            return { ...leg, bars: bars.bars };
          }),
        ),
      ]);

      const { rows, unexpiredCount } = buildContractRows({
        symbol,
        contractYears,
        fromIso: graphFrom,
        toIso: graphTo,
        todayIso,
      });

      setView(nextView);
      setStockBars(stock.bars);
      setContractRows(rows);
      setUnexpiredCount(unexpiredCount);
      setLegs(refetchedLegs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleRow(row: ContractRow) {
    setError('');
    const existing = legs.find((leg) => leg.occSymbol === row.occSymbol);
    if (existing) {
      setLegs((current) => current.filter((leg) => leg.occSymbol !== row.occSymbol));
      return;
    }
    if (!view || legs.length >= MAX_LEGS) return;
    const slot = [1, 2, 3, 4, 5, 6, 7].find((s) => !legs.some((leg) => leg.slot === s));
    if (slot === undefined) return;
    setBusy(true);
    try {
      const response = await fetchOptionBars(row.occSymbol, {
        fromIso: optionFrom,
        toIso: optionTo,
        timeframe: view.timeframe,
      });
      setLegs((current) => [
        ...current,
        {
          occSymbol: response.occSymbol,
          underlying: response.underlying,
          expirationIso: response.expirationIso,
          right: response.right,
          strikeCents: response.strikeCents,
          slot,
          bars: response.bars,
        },
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function applyOptionWindow(fromIso: string, toIso: string) {
    setOptionFrom(fromIso);
    setOptionTo(toIso);
    if (!view || legs.length === 0 || fromIso > toIso) return;
    setBusy(true);
    setError('');
    try {
      const refetched = await Promise.all(
        legs.map(async (leg) => {
          const response = await fetchOptionBars(leg.occSymbol, {
            fromIso,
            toIso,
            timeframe: view.timeframe,
          });
          return { ...leg, bars: response.bars };
        }),
      );
      setLegs(refetched);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Latest close in the window — what "near the money" is measured against. */
  const spotCents = useMemo(() => stockBars.at(-1)?.[4] ?? 0, [stockBars]);

  const { rows: filteredRows, atmOnly } = useMemo(
    () => selectContractView(contractRows, filter, spotCents),
    [contractRows, filter, spotCents],
  );

  const visibleStockBars = useMemo(
    () =>
      view?.timeframe === '1Min' && rthOnly
        ? stockBars.filter((bar) => isRegularHoursNy(bar[0]))
        : stockBars,
    [stockBars, rthOnly, view],
  );

  const chartLegs = useMemo<readonly PayoffLeg[]>(
    () =>
      legs.map((leg) => ({
        occSymbol: leg.occSymbol,
        label: leg.occSymbol,
        shortLabel: `${leg.right}${fmtUsd(leg.strikeCents).slice(1)}`,
        color: theme.series[leg.slot]!,
        right: leg.right,
        strikeCents: leg.strikeCents,
        bars: leg.bars,
      })),
    [legs, theme],
  );

  const selectedOccs = useMemo(() => new Set(legs.map((leg) => leg.occSymbol)), [legs]);

  return (
    <section className="space-y-4">
      {view ? (
        <PayoffChart
          stockSymbol={view.symbol}
          stockBars={visibleStockBars}
          legs={chartLegs}
          theme={theme}
        />
      ) : (
        <div className="chart-wrap flex h-[440px] items-center justify-center p-8 text-center text-muted">
          <p className="max-w-lg">
            Pick an underlying and a time window, hit Confirm, then select contracts from the table.
            Calls plot at strike + price and puts at strike − price on the stock's dollar axis — the
            gap to the stock (ITM) or the strike (OTM) is extrinsic value decaying toward expiry.
          </p>
        </div>
      )}

      {error && <p className="text-danger">{error}</p>}
      {busy && (
        <p className="text-muted">
          loading…
          {timeframeFor(graphFrom, graphTo) === '1Min' &&
            ' (the first minute-bar fetch of a new symbol can take a minute)'}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-hairline bg-surface p-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="symbol" className="text-xs tracking-wider text-muted uppercase">
            Underlying
          </label>
          <Input
            id="symbol"
            className="w-24"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs tracking-wider text-muted uppercase">Graph window</label>
          <div className="flex items-center gap-1">
            <Input
              type="date"
              value={graphFrom}
              onChange={(e) => setGraphFrom(e.target.value)}
              aria-label="graph window from"
            />
            <span className="text-muted">–</span>
            <Input
              type="date"
              value={graphTo}
              onChange={(e) => setGraphTo(e.target.value)}
              aria-label="graph window to"
            />
          </div>
        </div>
        <Button onClick={confirm} disabled={busy}>
          Confirm
        </Button>
        {view?.timeframe === '1Min' && (
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={rthOnly}
              onChange={(e) => setRthOnly(e.target.checked)}
            />
            regular hours only
          </label>
        )}
        {view?.timeframe === '1Day' && (
          <span className="self-center text-xs text-muted">daily bars (window &gt; 90 days)</span>
        )}
      </div>

      {view && (
        <div className="space-y-3 rounded-md border border-hairline bg-surface p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-56 flex-1 flex-col gap-1">
              <label htmlFor="filter" className="text-xs tracking-wider text-muted uppercase">
                Filter contracts
              </label>
              <Input
                id="filter"
                placeholder="e.g. put monthly 2026-03 $550"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs tracking-wider text-muted uppercase">Contract window</label>
              <div className="flex items-center gap-1">
                <Input
                  type="date"
                  value={optionFrom}
                  onChange={(e) => applyOptionWindow(e.target.value, optionTo)}
                  aria-label="contract window from"
                />
                <span className="text-muted">–</span>
                <Input
                  type="date"
                  value={optionTo}
                  onChange={(e) => applyOptionWindow(optionFrom, e.target.value)}
                  aria-label="contract window to"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge>
              <span className="h-2.5 w-2.5 rounded-xs" style={{ background: theme.series[0] }} />
              {view.symbol}
            </Badge>
            {legs.map((leg) => (
              <Badge key={leg.occSymbol}>
                <span
                  className="h-2.5 w-2.5 rounded-xs"
                  style={{ background: theme.series[leg.slot] }}
                />
                {leg.occSymbol} · {leg.right === 'C' ? 'K+C' : 'K−P'}
                <button
                  className="cursor-pointer text-muted hover:text-danger"
                  title="remove"
                  onClick={() =>
                    setLegs((current) => current.filter((l) => l.occSymbol !== leg.occSymbol))
                  }
                >
                  <X size={12} />
                </button>
              </Badge>
            ))}
            {legs.length === 0 && (
              <span className="text-xs text-muted">
                no contracts selected — click a table row to plot it
              </span>
            )}
          </div>

          <ContractsTable
            rows={filteredRows.slice(0, TABLE_CAP)}
            selected={selectedOccs}
            onToggle={toggleRow}
          />
          <p className="text-xs text-muted">
            {atmOnly
              ? `${contractRows.length.toLocaleString()} expired contracts in this window — showing the ${ATM_PER_EXPIRATION} strikes nearest ${fmtUsd(spotCents)} per expiration; type above to search all of them`
              : filteredRows.length > TABLE_CAP
                ? `showing ${TABLE_CAP} of ${filteredRows.length.toLocaleString()} matches — refine the filter`
                : `${filteredRows.length.toLocaleString()} match${filteredRows.length === 1 ? '' : 'es'}`}
            {unexpiredCount > 0 &&
              ` · ${unexpiredCount} expiration${unexpiredCount === 1 ? '' : 's'} not yet expired (hidden — no complete history)`}
          </p>
        </div>
      )}
    </section>
  );
}
