import { useMemo, useState } from 'react';
import { BacktestChart, exitReasonColor } from '../components/backtest-chart';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import {
  fetchShortPutBacktest,
  fetchStockBars,
  fmtUsd,
  type MinuteBarTuple,
  type ShortPutBacktestResponse,
} from '../lib/api';
import { useTheme } from '../theme';

/** Form fields, defaults matching the CLI runner (`npm run backtest`). */
const FIELDS = [
  { key: 'dteMin', label: 'DTE min', def: '40', width: 'w-16' },
  { key: 'dteMax', label: 'DTE max', def: '50', width: 'w-16' },
  { key: 'targetDelta', label: 'target |Δ|', def: '0.16', width: 'w-20' },
  { key: 'deltaTolerance', label: 'Δ tol', def: '0.04', width: 'w-20' },
  { key: 'minIvRank', label: 'min IVR', def: '30', width: 'w-16' },
  { key: 'profitPct', label: 'profit %', def: '50', width: 'w-16' },
  { key: 'stopPct', label: 'stop %', def: '300', width: 'w-16' },
  { key: 'timeExitDte', label: 'time exit DTE', def: '21', width: 'w-16' },
  { key: 'slippageCents', label: 'slip ¢', def: '3', width: 'w-14' },
  { key: 'feeCents', label: 'fee ¢', def: '5', width: 'w-14' },
  { key: 'ratePct', label: 'rate %', def: '4.5', width: 'w-16' },
  { key: 'divYieldPct', label: 'div %', def: '1.2', width: 'w-16' },
  { key: 'ivLookback', label: 'IVR lookback', def: '252', width: 'w-16' },
  { key: 'ivMinObs', label: 'IVR min obs', def: '60', width: 'w-16' },
] as const;

type FieldKey = (typeof FIELDS)[number]['key'];

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function BacktestPage() {
  const theme = useTheme();
  const todayIso = useMemo(
    () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    [],
  );

  const [symbolInput, setSymbolInput] = useState('SPY');
  const [startInput, setStartInput] = useState('2024-05-01');
  const [endInput, setEndInput] = useState(todayIso);
  const [fields, setFields] = useState<Record<FieldKey, string>>(
    () => Object.fromEntries(FIELDS.map((f) => [f.key, f.def])) as Record<FieldKey, string>,
  );
  const [data, setData] = useState<ShortPutBacktestResponse | null>(null);
  const [stockBars, setStockBars] = useState<readonly MinuteBarTuple[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function confirm() {
    if (busy) return; // Enter in an input must not stack a second run
    const sym = symbolInput.trim().toUpperCase();
    if (!/^[A-Z]{1,6}$/.test(sym)) {
      setError('enter a stock symbol (1–6 letters)');
      return;
    }
    if (!startInput || !endInput || startInput >= endInput) {
      setError('window is empty or backwards');
      return;
    }
    // Every field must be a number — silently falling back to a server
    // default would run a backtest that doesn't match the form.
    const numeric: Record<string, number> = {};
    for (const field of FIELDS) {
      const raw = fields[field.key].trim();
      const value = Number(raw);
      if (raw === '' || !Number.isFinite(value)) {
        setError(`enter a number for "${field.label}"`);
        return;
      }
      numeric[field.key] = value;
    }
    setBusy(true);
    setError('');
    try {
      const [result, stock] = await Promise.all([
        fetchShortPutBacktest({
          underlying: sym,
          startIso: startInput,
          endIso: endInput,
          ...numeric,
        }),
        fetchStockBars(sym, startInput, endInput, '1Day'),
      ]);
      setData(result);
      setStockBars(stock.bars);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const metricsTiles = useMemo<
    readonly { readonly label: string; readonly value: string; readonly signCents?: number }[]
  >(() => {
    if (!data) return [];
    const m = data.metrics;
    const money = (c: number, signed = false) =>
      `${signed && c > 0 ? '+' : ''}${fmtUsd(Math.round(c))}`;
    return [
      { label: 'trades', value: String(m.tradeCount) },
      { label: 'total P&L', value: money(m.totalPnlCents, true), signCents: m.totalPnlCents },
      { label: 'win rate', value: pct(m.winRate) },
      { label: 'expectancy', value: money(m.expectancyCents, true), signCents: m.expectancyCents },
      { label: 'avg win / loss', value: `${money(m.avgWinCents)} / ${money(m.avgLossCents)}` },
      { label: 'max drawdown', value: money(m.maxDrawdownCents) },
      { label: 'avg hold', value: `${m.avgHoldTradingDays.toFixed(1)}d` },
      { label: 'exposure', value: pct(m.exposureRate) },
      { label: 'IVR-blocked', value: pct(m.filterBlockRate) },
      { label: 'annualized (CSC)', value: `${m.annualizedReturnPct.toFixed(2)}%` },
    ];
  }, [data]);

  // Running total in close order (the order trades realize, and the order
  // the table lists) — the last row matches the total P&L tile.
  const tradeRows = useMemo(() => {
    if (!data) return [];
    let cumPnlCents = 0;
    return data.trades.map((trade) => {
      cumPnlCents += trade.pnlCents;
      return { trade, cumPnlCents };
    });
  }, [data]);

  return (
    <section className="space-y-4">
      {data ? (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {metricsTiles.map((tile) => (
              <div key={tile.label} className="flex flex-col">
                <span className="text-xs tracking-wider text-muted uppercase">{tile.label}</span>
                <span
                  className={
                    tile.signCents === undefined
                      ? 'text-sm'
                      : tile.signCents >= 0
                        ? 'text-sm text-good'
                        : 'text-sm text-danger'
                  }
                >
                  {tile.value}
                </span>
              </div>
            ))}
          </div>

          <BacktestChart
            symbol={data.params.underlying}
            stockBars={stockBars}
            trades={data.trades}
            equityCurve={data.equityCurve}
            minIvRank={data.params.minIvRank}
            theme={theme}
          />
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <span>
              <span style={{ color: theme.series[0] }}>▲</span> entry (sell put, strike label)
            </span>
            <span>
              <span style={{ color: exitReasonColor('profit_target', theme) }}>▼</span> profit
              target
            </span>
            <span>
              <span style={{ color: exitReasonColor('stop_loss', theme) }}>▼</span> stop loss
            </span>
            <span>
              <span style={{ color: exitReasonColor('time_exit', theme) }}>▼</span> time exit
            </span>
            <span>
              <span style={{ color: exitReasonColor('end_of_data', theme) }}>▼</span> end of data
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4" style={{ background: theme.series[1] }} />
              equity
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-4" style={{ background: theme.series[6] }} />
              IV rank (left axis, dashed = entry threshold)
            </span>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entry</TableHead>
                <TableHead>Exit</TableHead>
                <TableHead>Contract</TableHead>
                <TableHead>Δ</TableHead>
                <TableHead>IV</TableHead>
                <TableHead>IVR</TableHead>
                <TableHead>Credit</TableHead>
                <TableHead>Exit cost</TableHead>
                <TableHead>P&L</TableHead>
                <TableHead>Cum P&L</TableHead>
                <TableHead>Hold</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tradeRows.map(({ trade, cumPnlCents }) => (
                <TableRow key={`${trade.occSymbol}-${trade.entryDateIso}`}>
                  <TableCell>{trade.entryDateIso}</TableCell>
                  <TableCell>{trade.exitDateIso}</TableCell>
                  <TableCell>
                    {trade.expirationIso} P{trade.strikeCents / 100}
                  </TableCell>
                  <TableCell>{trade.entryDelta.toFixed(2)}</TableCell>
                  <TableCell>{(trade.entryIv * 100).toFixed(1)}%</TableCell>
                  <TableCell>{trade.entryIvRank.toFixed(0)}</TableCell>
                  <TableCell>{fmtUsd(trade.entryCreditCents)}</TableCell>
                  <TableCell>{fmtUsd(trade.exitCostCents)}</TableCell>
                  <TableCell className={trade.pnlCents >= 0 ? 'text-good' : 'text-danger'}>
                    {trade.pnlCents >= 0 ? '+' : '−'}
                    {fmtUsd(Math.abs(trade.pnlCents))}
                  </TableCell>
                  <TableCell className={cumPnlCents >= 0 ? 'text-good' : 'text-danger'}>
                    {cumPnlCents >= 0 ? '+' : '−'}
                    {fmtUsd(Math.abs(cumPnlCents))}
                  </TableCell>
                  <TableCell>{trade.holdTradingDays}d</TableCell>
                  <TableCell style={{ color: exitReasonColor(trade.exitReason, theme) }}>
                    {trade.exitReason.replaceAll('_', ' ')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {data.trades.length === 0 && (
            <p className="text-muted">
              no trades — the entry filter never triggered in this window
            </p>
          )}
        </>
      ) : (
        <div className="chart-wrap flex h-[440px] items-center justify-center p-8 text-center text-muted">
          <p className="max-w-lg">
            The systematic short put, replayed against history: each day the backtest sells a ~
            {fields.targetDelta}Δ put {fields.dteMin}–{fields.dteMax} DTE when IV rank clears{' '}
            {fields.minIvRank}, then exits at +{fields.profitPct}% of credit, {fields.stopPct}% cost
            stop, or {fields.timeExitDte} DTE. Confirm to plot every transaction on the price chart
            — ▲ entries, ▼ exits colored by reason — with the equity curve and IV rank below, and
            the full trade log as a table.
          </p>
        </div>
      )}

      {error && <p className="text-danger">{error}</p>}
      {busy && (
        <p className="text-muted">
          running… (a cold window fetches each entry day&apos;s option strip; the first run can take
          a few minutes, warm reruns are seconds)
        </p>
      )}

      <div className="space-y-3 rounded-md border border-hairline bg-surface p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="bt-symbol" className="text-xs tracking-wider text-muted uppercase">
              Underlying
            </label>
            <Input
              id="bt-symbol"
              className="w-24"
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && confirm()}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs tracking-wider text-muted uppercase">Window</label>
            <div className="flex items-center gap-1">
              <Input
                type="date"
                min="2024-02-01"
                max={todayIso}
                value={startInput}
                onChange={(e) => setStartInput(e.target.value)}
                aria-label="backtest start"
              />
              <span className="text-muted">–</span>
              <Input
                type="date"
                min="2024-02-01"
                max={todayIso}
                value={endInput}
                onChange={(e) => setEndInput(e.target.value)}
                aria-label="backtest end"
              />
            </div>
          </div>
          <Button onClick={confirm} disabled={busy}>
            Confirm
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {FIELDS.map((field) => (
            <div key={field.key} className="flex flex-col gap-1">
              <label
                htmlFor={`bt-${field.key}`}
                className="text-xs tracking-wider text-muted uppercase"
              >
                {field.label}
              </label>
              <Input
                id={`bt-${field.key}`}
                className={field.width}
                value={fields[field.key]}
                onChange={(e) =>
                  setFields((current) => ({ ...current, [field.key]: e.target.value }))
                }
                onKeyDown={(e) => e.key === 'Enter' && confirm()}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
