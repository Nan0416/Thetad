import {
  CandlestickSeries,
  createChart,
  CrosshairMode,
  LineSeries,
  TickMarkType,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { VolPoint } from '../lib/api';
import type { ThemeTokens } from '../theme';

export interface VolSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  /** [dateIso | tsUtc, vol-as-decimal]. */
  readonly points: readonly VolPoint[];
  /** Dashed for the single-contract overlays, solid for RV/IV. */
  readonly dashed?: boolean;
}

/** [dateIso | tsUtc, open, high, low, close] in dollars. */
export type PriceCandle = readonly [string, number, number, number, number];

export interface PriceSeries {
  readonly label: string;
  readonly candles: readonly PriceCandle[];
}

export interface VolatilityChartProps {
  readonly series: readonly VolSeries[];
  readonly theme: ThemeTokens;
  /** Underlying price as candlesticks on the left $ axis (vol stays on the right % axis). */
  readonly priceSeries?: PriceSeries;
}

// Subdued candle colors so price context doesn't overpower the vol lines.
const CANDLE_UP = '#4f9d78';
const CANDLE_DOWN = '#c56b6b';

/**
 * Annualized volatility over time on the right percent axis: realized vol,
 * constant-maturity ATM IV, VIX, and any single-contract IV. Optionally the
 * underlying price on a left dollar axis — a deliberate dual scale (the two
 * are different units), kept muted so it reads as backdrop, not a series.
 */
export function VolatilityChart({ series, theme, priceSeries }: VolatilityChartProps) {
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
      },
      grid: {
        vertLines: { color: theme.grid },
        horzLines: { color: theme.grid },
      },
      rightPriceScale: { borderColor: theme.axis, visible: true },
      leftPriceScale: { borderColor: theme.axis, visible: priceSeries !== undefined },
      timeScale: { borderColor: theme.axis, tickMarkFormatter: nyTick, minBarSpacing: 0.05 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: {
        timeFormatter: (time: number) => nyStamp.format(new Date(time * 1000)),
      },
    });

    const pctFormat = {
      type: 'custom' as const,
      formatter: (v: number) => `${(v * 100).toFixed(1)}%`,
      minMove: 0.0001,
    };
    const usdFormat = {
      type: 'custom' as const,
      formatter: (v: number) => `$${v.toFixed(0)}`,
      minMove: 0.01,
    };

    const toTime = (stamp: string): UTCTimestamp =>
      Math.floor(
        Date.parse(stamp.length <= 10 ? `${stamp}T20:00:00Z` : stamp) / 1000,
      ) as UTCTimestamp;

    interface Entry {
      readonly label: string;
      readonly color: string;
      readonly isPrice: boolean;
      readonly points: readonly { time: UTCTimestamp; value: number }[];
    }
    const entries: Entry[] = [];
    const lastValueAt = (points: Entry['points'], time: number): number | undefined => {
      let lo = 0;
      let hi = points.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid]!.time <= time) {
          best = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return best >= 0 ? points[best]!.value : undefined;
    };

    // Price first, on the left $ axis, so the vol lines draw over it.
    if (priceSeries && priceSeries.candles.length > 0) {
      const candles = chart.addSeries(CandlestickSeries, {
        priceScaleId: 'left',
        priceFormat: usdFormat,
        upColor: CANDLE_UP,
        downColor: CANDLE_DOWN,
        borderVisible: false,
        wickUpColor: CANDLE_UP,
        wickDownColor: CANDLE_DOWN,
        title: priceSeries.label,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      candles.setData(
        priceSeries.candles.map(([stamp, open, high, low, close]) => ({
          time: toTime(stamp),
          open,
          high,
          low,
          close,
        })),
      );
      // Tooltip tracks the close.
      const closes = priceSeries.candles.map(([stamp, , , , close]) => ({
        time: toTime(stamp),
        value: close,
      }));
      entries.push({ label: priceSeries.label, color: theme.ink, isPrice: true, points: closes });
    }

    for (const s of series) {
      if (s.points.length === 0) continue;
      const line = chart.addSeries(LineSeries, {
        color: s.color,
        lineWidth: 2,
        lineStyle: s.dashed ? 2 : 0,
        priceFormat: pctFormat,
        title: s.label,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const data = s.points.map(([stamp, value]) => ({ time: toTime(stamp), value }));
      line.setData(data);
      entries.push({ label: s.label, color: s.color, isPrice: false, points: data });
    }
    chart.timeScale().fitContent();

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        tooltip.style.display = 'none';
        return;
      }
      const rows: string[] = [];
      for (const entry of entries) {
        const value = lastValueAt(entry.points, param.time as number);
        if (value === undefined) continue;
        const shown = entry.isPrice ? `$${value.toFixed(2)}` : `${(value * 100).toFixed(1)}%`;
        rows.push(`<span style="color:${entry.color}">●</span> ${entry.label} ${shown}`);
      }
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
  }, [series, theme, priceSeries]);

  return (
    <div className="chart-wrap">
      <div ref={containerRef} className="chart-container" />
      <div ref={tooltipRef} className="chart-tooltip" />
    </div>
  );
}
