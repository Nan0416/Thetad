import {
  createChart,
  CrosshairMode,
  LineSeries,
  LineStyle,
  TickMarkType,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { MinuteBarTuple, OptionRight } from '../lib/api';
import { fmtUsd } from '../lib/api';
import type { ThemeTokens } from '../theme';

export interface PayoffLeg {
  readonly occSymbol: string;
  readonly label: string;
  /** Compact form for the price axis and tooltip, e.g. "P600". */
  readonly shortLabel: string;
  readonly color: string;
  readonly right: OptionRight;
  readonly strikeCents: number;
  readonly bars: readonly MinuteBarTuple[];
}

export interface PayoffChartProps {
  readonly stockSymbol: string;
  readonly stockBars: readonly MinuteBarTuple[];
  readonly legs: readonly PayoffLeg[];
  readonly theme: ThemeTokens;
}

/**
 * The strike-anchored payoff view: the stock close, and each option leg
 * plotted at strike + price (calls) / strike − price (puts) so every curve
 * shares the stock's dollar axis. At expiry a call curve converges to
 * max(S, K) and a put curve to min(S, K); the remaining gap is extrinsic
 * value. Dashed line marks each strike.
 */
export function PayoffChart({ stockSymbol, stockBars, legs, theme }: PayoffChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const tooltip = tooltipRef.current;
    if (!container || !tooltip) return;

    const nyStamp = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const nyTick = (time: number, type: TickMarkType): string => {
      const parts = Object.fromEntries(
        nyStamp.formatToParts(new Date(time * 1000)).map((p) => [p.type, p.value]),
      );
      if (type === TickMarkType.Year) return String(new Date(time * 1000).getUTCFullYear());
      if (type === TickMarkType.Month) return `${parts.month}`;
      if (type === TickMarkType.DayOfMonth) return `${parts.month} ${parts.day}`;
      return `${parts.hour}:${parts.minute}`;
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
      rightPriceScale: { borderColor: theme.axis },
      timeScale: {
        borderColor: theme.axis,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: nyTick,
        // Weeks of minute bars must still fit in one view.
        minBarSpacing: 0.001,
      },
      crosshair: { mode: CrosshairMode.Normal },
      localization: {
        priceFormatter: (price: number) => `$${price.toFixed(2)}`,
        timeFormatter: (time: number) => `${nyStamp.format(new Date(time * 1000))} NY`,
      },
    });

    const toPoint = ([tsUtc, , , , closeCents]: MinuteBarTuple, offsetCents = 0, sign = 1) => ({
      time: Math.floor(Date.parse(tsUtc) / 1000) as UTCTimestamp,
      value: (offsetCents + sign * closeCents) / 100,
    });

    // Option bars are sparse (only minutes the contract traded), so the
    // tooltip reads each curve's last value at-or-before the crosshair
    // rather than requiring an exact-minute match.
    interface Entry {
      readonly name: string;
      readonly color: string;
      readonly leg?: PayoffLeg;
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
        } else {
          hi = mid - 1;
        }
      }
      return best >= 0 ? points[best]!.value : undefined;
    };

    const stockSeries = chart.addSeries(LineSeries, {
      color: theme.series[0]!,
      lineWidth: 2,
      title: stockSymbol,
      priceLineVisible: false,
    });
    const stockPoints = stockBars.map((bar) => toPoint(bar));
    stockSeries.setData(stockPoints);
    entries.push({ name: stockSymbol, color: theme.series[0]!, points: stockPoints });

    for (const leg of legs) {
      const series = chart.addSeries(LineSeries, {
        color: leg.color,
        lineWidth: 2,
        title: leg.shortLabel,
        priceLineVisible: false,
      });
      const sign = leg.right === 'C' ? 1 : -1;
      const points = leg.bars.map((bar) => toPoint(bar, leg.strikeCents, sign));
      series.setData(points);
      series.createPriceLine({
        price: leg.strikeCents / 100,
        color: leg.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: `K ${fmtUsd(leg.strikeCents)}`,
      });
      entries.push({ name: leg.shortLabel, color: leg.color, leg, points });
    }

    chart.timeScale().fitContent();

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        tooltip.style.display = 'none';
        return;
      }
      const rows: string[] = [];
      for (const { name, color, leg, points } of entries) {
        const value = lastValueAt(points, param.time as number);
        if (value === undefined) continue;
        const chip = `<span style="color:${color}">●</span>`;
        if (leg) {
          const premium =
            leg.right === 'C' ? value - leg.strikeCents / 100 : leg.strikeCents / 100 - value;
          rows.push(`${chip} ${name} $${value.toFixed(2)} · prem $${premium.toFixed(2)}`);
        } else {
          rows.push(`${chip} ${name} $${value.toFixed(2)}`);
        }
      }
      if (rows.length === 0) {
        tooltip.style.display = 'none';
        return;
      }
      const stamp = nyStamp.format(new Date((param.time as number) * 1000));
      tooltip.innerHTML = `<div class="t">${stamp} NY</div>${rows.join('<br/>')}`;
      tooltip.style.display = 'block';
      const pad = 12;
      const flipX = param.point.x > container.clientWidth - tooltip.offsetWidth - pad * 2;
      const flipY = param.point.y > container.clientHeight - tooltip.offsetHeight - pad * 2;
      tooltip.style.left = `${param.point.x + (flipX ? -tooltip.offsetWidth - pad : pad)}px`;
      tooltip.style.top = `${param.point.y + (flipY ? -tooltip.offsetHeight - pad : pad)}px`;
    });

    return () => chart.remove();
  }, [stockSymbol, stockBars, legs, theme]);

  return (
    <div className="chart-wrap">
      <div ref={containerRef} className="chart-container" />
      <div ref={tooltipRef} className="chart-tooltip" />
    </div>
  );
}
