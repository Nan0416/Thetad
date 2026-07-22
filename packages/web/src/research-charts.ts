import type { ComponentType } from 'react';
import { PayoffPage } from './pages/payoff-page';
import { VolatilityPage } from './pages/volatility-page';

/**
 * The research section's charts. One entry drives both the catalog table and
 * the router — adding a chart means appending here, nothing else. The slug is
 * the URL under research/ (e.g. #/research/daily-payoff).
 */
export interface ResearchChart {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly Component: ComponentType;
}

export const RESEARCH_CHARTS: readonly ResearchChart[] = [
  {
    slug: 'daily-payoff',
    title: 'Option payoff',
    description:
      "An underlying and its expired option contracts on one dollar axis — calls drawn at strike + price, puts at strike − price — so each option's time value melting toward expiry is visible against the stock.",
    Component: PayoffPage,
  },
  {
    slug: 'volatility',
    title: 'Implied vs realized volatility',
    description:
      'Realized volatility (rolling close-to-close) against a constant-maturity ATM implied-vol line and VIX, over time. Surfaces the variance risk premium and the implied-vol crush around earnings and other events.',
    Component: VolatilityPage,
  },
];

export function findResearchChart(slug: string): ResearchChart | undefined {
  return RESEARCH_CHARTS.find((chart) => chart.slug === slug);
}
