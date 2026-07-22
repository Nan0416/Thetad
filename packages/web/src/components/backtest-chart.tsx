import {
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  LineSeries,
  LineStyle,
  TickMarkType,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type {
  BacktestExitReason,
  BacktestTrade,
  EquityPointTuple,
  MinuteBarTuple,
} from '../lib/api';
import type { ThemeTokens } from '../theme';

export interface BacktestChartProps {
  readonly symbol: string;
  /** Daily bars over the backtest window. */
  readonly stockBars: readonly MinuteBarTuple[];
  readonly trades: readonly BacktestTrade[];
  readonly equityCurve: readonly EquityPointTuple[];
  /** The entry filter threshold, drawn on the IV-rank scale. */
  readonly minIvRank: number;
  readonly theme: ThemeTokens;
}

/** Exit-reason colors, shared with the trades table and legend. */
export function exitReasonColor(reason: BacktestExitReason, mode: 'light' | 'dark'): string {
  switch (reason) {
    case 'profit_target':
      return '#0ca30c';
    case 'stop_loss':
      return mode === 'light' ? '#d03b3b' : '#e66767';
    case 'time_exit':
      return mode === 'light' ? '#eda100' : '#c98500';
    case 'end_of_data':
      return '#898781';
  }
}

/**
 * The backtest, two panes on one time axis: the underlying's daily closes
 * with a marker per transaction (▲ below the bar sells the put, ▼ above it
 * buys it back, colored by exit reason), and beneath it the equity curve
 * with the IV-rank series and its entry threshold. The crosshair tooltip
 * lists that day's values plus any transaction details.
 */
export function BacktestChart({
  symbol,
  stockBars,
  trades,
  equityCurve,
  minIvRank,
  theme,
}: BacktestChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const tooltip = tooltipRef.current;
    if (!container || !tooltip) return;

    const nyStamp = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const nyTick = (time: number, type: TickMarkType): string => {
      const d = new Date(time * 1000);
      if (type === TickMarkType.Year) return String(d.getUTCFullYear());
      const parts = Object.fromEntries(nyStamp.formatToParts(d).map((p) => [p.type, p.value]));
      return type === TickMarkType.DayOfMonth ? `${parts.month} ${parts.day}` : `${parts.month}`;
    };

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: theme.surface },
        textColor: theme.muted,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        attributionLogo: false,
        panes: { separatorColor: theme.axis, enableResize: false },
      },
      grid: {
        vertLines: { color: theme.grid },
        horzLines: { color: theme.grid },
      },
      rightPriceScale: { borderColor: theme.axis, visible: true },
      timeScale: { borderColor: theme.axis, tickMarkFormatter: nyTick, minBarSpacing: 0.05 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: {
        timeFormatter: (time: number) => nyStamp.format(new Date(time * 1000)),
      },
    });

    const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
    const toTime = (dateIso: string): UTCTimestamp =>
      Math.floor(Date.parse(`${dateIso}T20:00:00Z`) / 1000) as UTCTimestamp;
    const toDateIso = (time: number): string => new Date(time * 1000).toISOString().slice(0, 10);

    // Pane 0: the underlying, with one marker per transaction.
    const priceLine = chart.addSeries(
      LineSeries,
      {
        color: theme.series[0]!,
        lineWidth: 2,
        title: symbol,
        priceFormat: {
          type: 'custom',
          formatter: (v: number) => `$${v.toFixed(0)}`,
          minMove: 0.01,
        },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      0,
    );
    priceLine.setData(
      stockBars.map(([tsUtc, , , , closeCents]) => ({
        time: toTime(tsUtc.slice(0, 10)),
        value: closeCents / 100,
      })),
    );

    const markers: SeriesMarker<UTCTimestamp>[] = [];
    for (const trade of trades) {
      markers.push({
        time: toTime(trade.entryDateIso),
        position: 'belowBar',
        shape: 'arrowUp',
        color: theme.series[0]!,
        text: `${trade.strikeCents / 100}P`,
      });
      markers.push({
        time: toTime(trade.exitDateIso),
        position: 'aboveBar',
        shape: 'arrowDown',
        color: exitReasonColor(trade.exitReason, theme.mode),
        text: `${trade.pnlCents >= 0 ? '+' : '−'}$${Math.abs(Math.round(trade.pnlCents / 100))}`,
      });
    }
    markers.sort((a, b) => a.time - b.time);
    createSeriesMarkers(priceLine, markers);

    // Pane 1: equity ($, right scale) and IV rank (0-100, left scale).
    const equityLine = chart.addSeries(
      LineSeries,
      {
        color: theme.series[1]!,
        lineWidth: 2,
        title: 'equity',
        priceFormat: {
          type: 'custom',
          formatter: (v: number) => `$${v.toFixed(0)}`,
          minMove: 0.01,
        },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      1,
    );
    equityLine.setData(
      equityCurve.map(([dateIso, equityCents]) => ({
        time: toTime(dateIso),
        value: equityCents / 100,
      })),
    );

    const ivRankLine = chart.addSeries(
      LineSeries,
      {
        color: theme.series[6]!,
        lineWidth: 1,
        title: 'IV rank',
        priceScaleId: 'left',
        priceFormat: { type: 'custom', formatter: (v: number) => v.toFixed(0), minMove: 1 },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      1,
    );
    ivRankLine.setData(
      equityCurve.flatMap(([dateIso, , ivRank]) =>
        ivRank === null ? [] : [{ time: toTime(dateIso), value: ivRank }],
      ),
    );
    ivRankLine.priceScale().applyOptions({ borderColor: theme.axis, visible: true });
    ivRankLine.createPriceLine({
      price: minIvRank,
      color: theme.series[6]!,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: 'min IVR',
    });

    const panes = chart.panes();
    panes[0]?.setStretchFactor(0.62);
    panes[1]?.setStretchFactor(0.38);
    chart.timeScale().fitContent();

    // Per-day lookups for the tooltip.
    const spotByDate = new Map(stockBars.map((b) => [b[0].slice(0, 10), b[4]]));
    const equityByDate = new Map(equityCurve.map((p) => [p[0], p]));
    const eventsByDate = new Map<string, string[]>();
    const pushEvent = (dateIso: string, html: string) => {
      const list = eventsByDate.get(dateIso) ?? [];
      list.push(html);
      eventsByDate.set(dateIso, list);
    };
    for (const trade of trades) {
      const strike = trade.strikeCents / 100;
      pushEvent(
        trade.entryDateIso,
        `<span style="color:${theme.series[0]}">▲</span> sold ${trade.expirationIso} P${strike} ` +
          `@ ${usd(trade.entryCreditCents)} · Δ${trade.entryDelta.toFixed(2)} · ` +
          `IV ${(trade.entryIv * 100).toFixed(1)}% · IVR ${trade.entryIvRank.toFixed(0)}`,
      );
      const color = exitReasonColor(trade.exitReason, theme.mode);
      pushEvent(
        trade.exitDateIso,
        `<span style="color:${color}">▼</span> closed P${strike} @ ${usd(trade.exitCostCents)} · ` +
          `${trade.pnlCents >= 0 ? '+' : '−'}${usd(Math.abs(trade.pnlCents))} ` +
          `(${trade.exitReason.replace('_', ' ')})`,
      );
    }

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        tooltip.style.display = 'none';
        return;
      }
      const dateIso = toDateIso(param.time as number);
      const rows: string[] = [];
      const spot = spotByDate.get(dateIso);
      if (spot !== undefined) rows.push(`${symbol} ${usd(spot)}`);
      const point = equityByDate.get(dateIso);
      if (point) {
        rows.push(
          `equity ${usd(point[1])}${point[2] === null ? '' : ` · IVR ${point[2].toFixed(0)}`}` +
            `${point[3] ? ' · in position' : ''}`,
        );
      }
      rows.push(...(eventsByDate.get(dateIso) ?? []));
      if (rows.length === 0) {
        tooltip.style.display = 'none';
        return;
      }
      tooltip.innerHTML = `<div class="t">${nyStamp.format(new Date((param.time as number) * 1000))}</div>${rows.join('<br/>')}`;
      tooltip.style.display = 'block';
      const pad = 12;
      const flipX = param.point.x > container.clientWidth - tooltip.offsetWidth - pad * 2;
      const flipY = param.point.y > container.clientHeight - tooltip.offsetHeight - pad * 2;
      tooltip.style.left = `${param.point.x + (flipX ? -tooltip.offsetWidth - pad : pad)}px`;
      tooltip.style.top = `${param.point.y + (flipY ? -tooltip.offsetHeight - pad : pad)}px`;
    });

    return () => chart.remove();
  }, [symbol, stockBars, trades, equityCurve, minIvRank, theme]);

  return (
    <div className="chart-wrap">
      <div ref={containerRef} className="chart-container-tall" />
      <div ref={tooltipRef} className="chart-tooltip" />
    </div>
  );
}
