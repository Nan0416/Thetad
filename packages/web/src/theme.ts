import { useEffect, useState } from 'react';

/**
 * Chart color tokens per mode (the CSS variables in styles.css hold the same
 * values; lightweight-charts needs them as plain hex). The categorical order
 * is fixed and CVD-validated — series claim slots in order, never re-colored.
 */
export interface ThemeTokens {
  readonly mode: 'light' | 'dark';
  readonly surface: string;
  readonly ink: string;
  readonly muted: string;
  readonly grid: string;
  readonly axis: string;
  /** Semantic status colors (P&L sign, exit reasons) — match styles.css. */
  readonly good: string;
  readonly danger: string;
  readonly warn: string;
  /** Slot 0 is the underlying; option legs claim 1..7. */
  readonly series: readonly string[];
}

const LIGHT: ThemeTokens = {
  mode: 'light',
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  good: '#0ca30c',
  danger: '#d03b3b',
  warn: '#eda100',
  series: ['#2a78d6', '#008300', '#e87ba4', '#eda100', '#1baf7a', '#eb6834', '#4a3aa7', '#e34948'],
};

const DARK: ThemeTokens = {
  mode: 'dark',
  surface: '#1a1a19',
  ink: '#ffffff',
  muted: '#898781',
  grid: '#2c2c2a',
  axis: '#383835',
  good: '#0ca30c',
  danger: '#e66767',
  warn: '#c98500',
  series: ['#3987e5', '#008300', '#d55181', '#c98500', '#199e70', '#d95926', '#9085e9', '#e66767'],
};

export function useTheme(): ThemeTokens {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return dark ? DARK : LIGHT;
}
