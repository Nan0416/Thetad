import { cents, type Cents } from '../core/money';
import type { BacktestExitReason, BacktestMetrics, ClosedTrade, EquityPoint } from './types';

export function computeMetrics(
  trades: readonly ClosedTrade[],
  equityCurve: readonly EquityPoint[],
  flatDays: number,
  blockedDays: number,
): BacktestMetrics {
  const wins = trades.filter((t) => t.pnlCents > 0);
  const losses = trades.filter((t) => t.pnlCents <= 0);
  const totalPnlCents = cents(trades.reduce((a, t) => a + t.pnlCents, 0));

  const exitBreakdown: Record<BacktestExitReason, number> = {
    profit_target: 0,
    stop_loss: 0,
    time_exit: 0,
    end_of_data: 0,
  };
  for (const trade of trades) exitBreakdown[trade.exitReason]++;

  let peak = 0;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equityCents);
    maxDrawdown = Math.max(maxDrawdown, peak - point.equityCents);
  }

  const inPositionDays = equityCurve.filter((p) => p.inPosition).length;
  const maxStrikeCents = trades.reduce((a, t) => Math.max(a, t.strikeCents), 0);
  const capitalCents = maxStrikeCents * 100;
  const years = equityCurve.length / 252;

  return {
    tradeCount: trades.length,
    totalPnlCents,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgWinCents: wins.length ? wins.reduce((a, t) => a + t.pnlCents, 0) / wins.length : 0,
    avgLossCents: losses.length ? losses.reduce((a, t) => a + t.pnlCents, 0) / losses.length : 0,
    expectancyCents: trades.length ? totalPnlCents / trades.length : 0,
    maxDrawdownCents: cents(maxDrawdown),
    exitBreakdown,
    avgHoldTradingDays: trades.length
      ? trades.reduce((a, t) => a + t.holdTradingDays, 0) / trades.length
      : 0,
    exposureRate: equityCurve.length ? inPositionDays / equityCurve.length : 0,
    filterBlockRate: flatDays ? blockedDays / flatDays : 0,
    annualizedReturnPct:
      capitalCents > 0 && years > 0 ? (totalPnlCents / capitalCents / years) * 100 : 0,
  };
}

export function formatReport(metrics: BacktestMetrics, trades: readonly ClosedTrade[]): string {
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `trades:            ${metrics.tradeCount}`,
    `total P&L:         ${usd(metrics.totalPnlCents)}`,
    `win rate:          ${pct(metrics.winRate)}`,
    `avg win / loss:    ${usd(metrics.avgWinCents)} / ${usd(metrics.avgLossCents)}`,
    `expectancy/trade:  ${usd(metrics.expectancyCents)}`,
    `max drawdown:      ${usd(metrics.maxDrawdownCents)}`,
    `avg hold (tdays):  ${metrics.avgHoldTradingDays.toFixed(1)}`,
    `exposure:          ${pct(metrics.exposureRate)}`,
    `IV-rank blocked:   ${pct(metrics.filterBlockRate)} of flat days`,
    `annualized (CSC):  ${metrics.annualizedReturnPct.toFixed(2)}%`,
    `exits:             ${Object.entries(metrics.exitBreakdown)
      .filter(([, n]) => n > 0)
      .map(([r, n]) => `${r}=${n}`)
      .join(', ')}`,
  ];
  if (trades.length > 0) {
    lines.push('', 'trade log:');
    for (const t of trades) {
      lines.push(
        `  ${t.entryDateIso} -> ${t.exitDateIso}  ${t.occSymbol}  ` +
          `Δ${t.entryDelta.toFixed(2)} iv=${(t.entryIv * 100).toFixed(1)}% rank=${t.entryIvRank.toFixed(0)}  ` +
          `credit=${usd(t.entryCreditCents)} pnl=${usd(t.pnlCents)} (${t.exitReason})`,
      );
    }
  }
  return lines.join('\n');
}
