import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ContractsTable, type ContractRow } from '../components/contracts-table';
import { VolatilityChart, type VolSeries } from '../components/volatility-chart';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  fetchContractIv,
  fetchContracts,
  fetchStockBars,
  fetchVolatility,
  fmtUsd,
  type MinuteBarTuple,
  type VolatilityResponse,
  type VolPoint,
} from '../lib/api';
import {
  ATM_PER_EXPIRATION,
  buildContractRows,
  MIN_CONTRACT_YEAR,
  selectContractView,
  TABLE_CAP,
  type SearchableRow,
} from '../lib/contracts';
import { isoDaysAgo, timeframeFor } from '../lib/dates';
import { useTheme } from '../theme';

interface SelectedContract {
  readonly occSymbol: string;
  readonly slot: number;
  readonly points: readonly VolPoint[];
}

/** Palette slots by role, so nothing collides: IV, VIX benchmark, RV windows,
 * then contract overlays. Price rides its own muted color, not the palette. */
const IV_SLOT = 0;
const VIX_SLOT = 7;
const RV_SLOTS = [5, 3, 4, 1] as const;
const CONTRACT_SLOTS = [2, 6] as const;

/** Parse a comma-separated "20, 60" into day counts. Empty = no RV. */
function parseRvWindows(raw: string): readonly number[] {
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 2 && n <= 250);
}

/**
 * Trim absurd candle wicks before charting. A daily bar whose low/high sits
 * past half/double its open–close body is a bad tick (e.g. a missing-digit
 * $69.01 low on a $690 day); left in, its wick drags the price axis to near
 * zero and squishes the real range. The reliable open/close body is kept.
 */
function sanitizeCandle(
  o: number,
  h: number,
  l: number,
  c: number,
): [number, number, number, number] {
  const bodyLow = Math.min(o, c);
  const bodyHigh = Math.max(o, c);
  const low = l < bodyLow * 0.5 ? bodyLow : l;
  const high = h > bodyHigh * 2 ? bodyHigh : h;
  return [o, high, low, c];
}

export function VolatilityPage() {
  const theme = useTheme();
  const todayIso = useMemo(
    () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    [],
  );

  const [symbolInput, setSymbolInput] = useState('SPY');
  const [graphFrom, setGraphFrom] = useState(isoDaysAgo(365, todayIso));
  const [graphTo, setGraphTo] = useState(todayIso);
  const [ivDteInput, setIvDteInput] = useState('30');
  const [rvWindowsInput, setRvWindowsInput] = useState('');
  const [showPrice, setShowPrice] = useState(true);
  const [showVix, setShowVix] = useState(true);
  const [symbol, setSymbol] = useState<string | null>(null);
  const [vol, setVol] = useState<VolatilityResponse | null>(null);
  const [stockBars, setStockBars] = useState<readonly MinuteBarTuple[]>([]);
  const [contractRows, setContractRows] = useState<readonly SearchableRow[]>([]);
  const [unexpiredCount, setUnexpiredCount] = useState(0);
  const [spotCents, setSpotCents] = useState(0);
  const [selected, setSelected] = useState<readonly SelectedContract[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    const sym = symbolInput.trim().toUpperCase();
    if (!/^[A-Z]{1,6}$/.test(sym)) {
      setError('enter a stock symbol (1–6 letters)');
      return;
    }
    if (graphFrom > graphTo) {
      setError('graph window is backwards');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const fromYear = Math.max(MIN_CONTRACT_YEAR, Number(graphFrom.slice(0, 4)));
      const toYear = Math.max(fromYear, Number(graphTo.slice(0, 4)));
      const years = Array.from({ length: toYear - fromYear + 1 }, (_, i) => fromYear + i);
      const ivDte = Number(ivDteInput) || 30;
      const [volatility, stock, contractYears] = await Promise.all([
        fetchVolatility(sym, graphFrom, graphTo, {
          ivDte,
          rvWindows: parseRvWindows(rvWindowsInput),
        }),
        fetchStockBars(sym, graphFrom, graphTo, '1Day'),
        Promise.all(years.map((year) => fetchContracts(sym, year))),
      ]);
      const { rows, unexpiredCount: hidden } = buildContractRows({
        symbol: sym,
        contractYears,
        fromIso: graphFrom,
        toIso: graphTo,
        todayIso,
      });
      setVol(volatility);
      setStockBars(stock.bars);
      setSpotCents(stock.bars.at(-1)?.[4] ?? 0);
      setContractRows(rows);
      setUnexpiredCount(hidden);
      if (sym !== symbol) setSelected([]); // different underlying: drop overlays
      setSymbol(sym);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleContract(row: ContractRow) {
    setError('');
    if (selected.some((s) => s.occSymbol === row.occSymbol)) {
      setSelected((current) => current.filter((s) => s.occSymbol !== row.occSymbol));
      return;
    }
    if (!symbol || selected.length >= CONTRACT_SLOTS.length) return;
    const slot = CONTRACT_SLOTS.find((s) => !selected.some((sel) => sel.slot === s));
    if (slot === undefined) return;
    setBusy(true);
    try {
      const timeframe = timeframeFor(graphFrom, graphTo);
      const response = await fetchContractIv(row.occSymbol, {
        fromIso: graphFrom,
        toIso: graphTo,
        timeframe,
      });
      // Daily points share the vol lines' per-day slot; minute points stay intraday.
      const points =
        timeframe === '1Day'
          ? response.points.map(([ts, iv]) => [ts.slice(0, 10), iv] as const)
          : response.points;
      setSelected((current) => [...current, { occSymbol: response.occSymbol, slot, points }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const { rows: filteredRows, atmOnly } = useMemo(
    () => selectContractView(contractRows, filter, spotCents),
    [contractRows, filter, spotCents],
  );

  const selectedOccs = useMemo(() => new Set(selected.map((s) => s.occSymbol)), [selected]);

  const chartSeries = useMemo<readonly VolSeries[]>(() => {
    if (!vol) return [];
    const series: VolSeries[] = [
      {
        key: 'iv',
        label: `ATM IV ~${vol.targetDte}d`,
        color: theme.series[IV_SLOT]!,
        points: vol.impliedAtm,
      },
    ];
    vol.rvWindows.forEach((w, i) => {
      series.push({
        key: `rv${w}`,
        label: `RV ${w}d`,
        color: theme.series[RV_SLOTS[i % RV_SLOTS.length]!]!,
        points: vol.realized[`window${w}`] ?? [],
      });
    });
    if (showVix && vol.vix.length > 0) {
      series.push({
        key: 'vix',
        label: 'VIX (S&P 500)',
        color: theme.series[VIX_SLOT]!,
        points: vol.vix,
      });
    }
    for (const s of selected) {
      series.push({
        key: s.occSymbol,
        label: s.occSymbol,
        color: theme.series[s.slot]!,
        points: s.points,
        dashed: true,
      });
    }
    return series;
  }, [vol, selected, theme, showVix]);

  const priceSeries = useMemo(
    () =>
      showPrice && stockBars.length > 0
        ? {
            label: symbol ?? 'price',
            // Stamp by NY date so candles share one x-slot per day with the
            // daily vol lines (which the chart keys off dateIso).
            candles: stockBars.map(([ts, o, h, l, c]) => {
              const [so, sh, sl, sc] = sanitizeCandle(o, h, l, c);
              return [ts.slice(0, 10), so / 100, sh / 100, sl / 100, sc / 100] as const;
            }),
          }
        : undefined,
    [showPrice, stockBars, symbol],
  );

  return (
    <section className="space-y-4">
      {vol ? (
        <>
          {priceSeries ? (
            <VolatilityChart series={chartSeries} theme={theme} priceSeries={priceSeries} />
          ) : (
            <VolatilityChart series={chartSeries} theme={theme} />
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            {priceSeries && (
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-4 rounded-xs"
                  style={{ background: 'linear-gradient(90deg, #4f9d78 50%, #c56b6b 50%)' }}
                />
                {priceSeries.label} (candles, left axis)
              </span>
            )}
            {chartSeries
              .filter((s) => s.points.length > 0)
              .map((s) => (
                <span key={s.key} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-0.5 w-4"
                    style={{
                      background: s.color,
                      ...(s.dashed && {
                        background: `repeating-linear-gradient(90deg, ${s.color} 0 4px, transparent 4px 7px)`,
                      }),
                    }}
                  />
                  {s.label}
                </span>
              ))}
          </div>
        </>
      ) : (
        <div className="chart-wrap flex h-[440px] items-center justify-center p-8 text-center text-muted">
          <p className="max-w-lg">
            Enter an underlying and a window, then Confirm to plot the constant-maturity
            at-the-money implied vol against the price candles and VIX. Add realized-vol windows
            (e.g. 20, 30, 60) to compare IV with what the stock actually did — IV sits above RV in
            calm markets (the variance risk premium) and trailing RV spikes above IV after a
            selloff. Select a contract to overlay its own IV path.
          </p>
        </div>
      )}

      {error && <p className="text-danger">{error}</p>}
      {busy && (
        <p className="text-muted">
          loading… (the implied-vol line inverts many contracts; the first run for a symbol can take
          a minute)
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
        <div className="flex flex-col gap-1">
          <label htmlFor="ivDte" className="text-xs tracking-wider text-muted uppercase">
            IV horizon (DTE)
          </label>
          <Input
            id="ivDte"
            className="w-20"
            type="number"
            min={1}
            max={400}
            value={ivDteInput}
            onChange={(e) => setIvDteInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="rvWindows" className="text-xs tracking-wider text-muted uppercase">
            RV windows (days)
          </label>
          <Input
            id="rvWindows"
            className="w-36"
            placeholder="e.g. 20, 30, 60"
            value={rvWindowsInput}
            onChange={(e) => setRvWindowsInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && confirm()}
          />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showPrice}
            onChange={(e) => setShowPrice(e.target.checked)}
          />
          price
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input type="checkbox" checked={showVix} onChange={(e) => setShowVix(e.target.checked)} />
          VIX
        </label>
        <Button onClick={confirm} disabled={busy}>
          Confirm
        </Button>
      </div>

      {vol && (
        <div className="space-y-3 rounded-md border border-hairline bg-surface p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-56 flex-1 flex-col gap-1">
              <label htmlFor="filter" className="text-xs tracking-wider text-muted uppercase">
                Overlay a contract's IV
              </label>
              <Input
                id="filter"
                placeholder="filter, e.g. put monthly 2025-06 $550"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          </div>

          {selected.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {selected.map((s) => (
                <Badge key={s.occSymbol}>
                  <span
                    className="h-2.5 w-2.5 rounded-xs"
                    style={{ background: theme.series[s.slot] }}
                  />
                  {s.occSymbol}
                  <button
                    className="cursor-pointer text-muted hover:text-danger"
                    title="remove"
                    onClick={() =>
                      setSelected((current) => current.filter((x) => x.occSymbol !== s.occSymbol))
                    }
                  >
                    <X size={12} />
                  </button>
                </Badge>
              ))}
            </div>
          )}

          <ContractsTable
            rows={filteredRows.slice(0, TABLE_CAP)}
            selected={selectedOccs}
            onToggle={toggleContract}
          />
          <p className="text-xs text-muted">
            {atmOnly
              ? `${contractRows.length.toLocaleString()} expired contracts — showing the ${ATM_PER_EXPIRATION} strikes nearest ${fmtUsd(spotCents)} per expiration; type above to search all of them`
              : filteredRows.length > TABLE_CAP
                ? `showing ${TABLE_CAP} of ${filteredRows.length.toLocaleString()} matches — refine the filter`
                : `${filteredRows.length.toLocaleString()} match${filteredRows.length === 1 ? '' : 'es'}`}
            {unexpiredCount > 0 &&
              ` · ${unexpiredCount} expiration${unexpiredCount === 1 ? '' : 's'} not yet expired (hidden)`}
          </p>
        </div>
      )}
    </section>
  );
}
