import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { fmtUsd, type SkewResponse } from '../lib/api';
import { makeRamp, rampCssGradient } from '../lib/ramp';
import type { ThemeTokens } from '../theme';

export type SkewRights = 'C' | 'P' | 'both';

export interface SkewHeatmapProps {
  readonly data: SkewResponse;
  readonly rights: SkewRights;
  readonly theme: ThemeTokens;
}

/**
 * The skew surface: expirations across, strikes up, implied vol as color.
 * Each cell splits into halves — ▌ call, ▐ put — on two sequential ramps
 * (blue/orange) sharing one IV domain so the sides stay comparable.
 * A traded close with no Black-Scholes solution (deep ITM closes below
 * intrinsic vs the later stock close) renders neutral gray.
 */

/** Low → high IV; each mode's low end recedes toward its surface. */
const CALL_STOPS = {
  light: ['#cde2fb', '#5598e7', '#1c5cab', '#0d366b'],
  dark: ['#1c3252', '#2a78d6', '#86b6ef', '#cde2fb'],
} as const;
const PUT_STOPS = {
  light: ['#fbe0cc', '#ee8a5b', '#c94f16', '#7a2d0e'],
  dark: ['#4a2513', '#c95a1f', '#f09a63', '#fbd9c0'],
} as const;

const ML = 56;
const MR = 8;
const MT = 6;
const MB = 48;

/** Interpolated percentile of an ascending array. */
function percentile(sortedAsc: readonly number[], p: number): number {
  const at = (sortedAsc.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (at - lo);
}

function fmtIv(iv: number | null): string {
  return iv === null ? 'IV n/a' : `IV ${(iv * 100).toFixed(1)}%`;
}

interface Hover {
  readonly r: number;
  readonly c: number;
  readonly px: number;
  readonly py: number;
}

export function SkewHeatmap({ data, rights, theme }: SkewHeatmapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(860);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { expirations, strikesCents, grid, spotCents } = data;
  const nCols = expirations.length;
  const nRows = strikesCents.length;
  const plotW = Math.max(nCols, width - ML - MR);
  const colW = plotW / nCols;
  // All-strikes grids run to ~200 rows: let rows shrink to 4px with a 1px
  // gap so the surface stays one screen tall; comfortable grids keep 2px.
  const rowH = Math.min(24, Math.max(4, Math.floor(640 / nRows)));
  const rowGap = rowH >= 8 ? 2 : 1;
  const plotH = nRows * rowH;
  const height = MT + plotH + MB;

  const callRamp = useMemo(() => makeRamp(CALL_STOPS[theme.mode]), [theme.mode]);
  const putRamp = useMemo(() => makeRamp(PUT_STOPS[theme.mode]), [theme.mode]);

  // Shared IV color domain over the visible sides, clamped to the 5th–95th
  // percentile so one 0DTE-style outlier doesn't wash out the surface.
  const domain = useMemo(() => {
    const ivs: number[] = [];
    for (const row of grid) {
      for (const cell of row) {
        if (!cell) continue;
        if (rights !== 'P' && cell[1] !== null) ivs.push(cell[1]);
        if (rights !== 'C' && cell[3] !== null) ivs.push(cell[3]);
      }
    }
    if (ivs.length === 0) return null;
    ivs.sort((a, b) => a - b);
    let lo = percentile(ivs, 0.05);
    let hi = percentile(ivs, 0.95);
    if (hi - lo < 0.005) {
      lo -= 0.005;
      hi += 0.005;
    }
    return { lo, hi };
  }, [grid, rights]);

  const cells = useMemo(() => {
    if (!domain) return [];
    const tOf = (iv: number) => (iv - domain.lo) / (domain.hi - domain.lo);
    const out: ReactElement[] = [];
    for (let r = 0; r < nRows; r++) {
      const strikeIndex = nRows - 1 - r;
      const row = grid[strikeIndex]!;
      const y = MT + r * rowH + (rowGap === 2 ? 1 : 0);
      const h = rowH - rowGap;
      for (let c = 0; c < nCols; c++) {
        const cell = row[c];
        if (!cell) continue;
        const [callClose, callIv, putClose, putIv] = cell;
        const x = ML + c * colW + 1;
        const w = colW - 2;
        const callFill =
          callClose === null ? null : callIv === null ? theme.grid : callRamp(tOf(callIv));
        const putFill =
          putClose === null ? null : putIv === null ? theme.grid : putRamp(tOf(putIv));
        const key = `${r}-${c}`;
        if (rights === 'C') {
          if (callFill)
            out.push(<rect key={key} x={x} y={y} width={w} height={h} fill={callFill} />);
          continue;
        }
        if (rights === 'P') {
          if (putFill) out.push(<rect key={key} x={x} y={y} width={w} height={h} fill={putFill} />);
          continue;
        }
        // Half-width halves with a 2px surface gap between them: ▌ call ▐ put.
        const halfW = (w - 2) / 2;
        if (callFill) {
          out.push(<rect key={`${key}c`} x={x} y={y} width={halfW} height={h} fill={callFill} />);
        }
        if (putFill) {
          out.push(
            <rect
              key={`${key}p`}
              x={x + halfW + 2}
              y={y}
              width={halfW}
              height={h}
              fill={putFill}
            />,
          );
        }
      }
    }
    return out;
  }, [grid, rights, domain, nRows, nCols, colW, rowH, theme, callRamp, putRamp]);

  // Spot marker: interpolated between the two neighboring strike rows.
  const spotY = useMemo(() => {
    if (spotCents <= strikesCents[0]!) return MT + plotH - rowH / 2;
    if (spotCents >= strikesCents[nRows - 1]!) return MT + rowH / 2;
    let k = 0;
    while (k < nRows - 2 && strikesCents[k + 1]! < spotCents) k++;
    const frac = (spotCents - strikesCents[k]!) / (strikesCents[k + 1]! - strikesCents[k]!);
    return MT + (nRows - 1 - (k + frac)) * rowH + rowH / 2;
  }, [spotCents, strikesCents, nRows, rowH, plotH]);

  const yLabelStep = Math.ceil(nRows / 12);
  const xLabelStep = Math.ceil(36 / colW);

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const c = Math.floor((px - ML) / colW);
    const r = Math.floor((py - MT) / rowH);
    if (c < 0 || c >= nCols || r < 0 || r >= nRows) {
      setHover(null);
      return;
    }
    setHover({ r, c, px, py });
  }

  const hoverCell = hover ? (grid[nRows - 1 - hover.r]?.[hover.c] ?? null) : null;
  const hoverExpiration = hover ? expirations[hover.c]! : null;
  const hoverStrike = hover ? strikesCents[nRows - 1 - hover.r]! : 0;
  const tooltipLeft = hover ? (hover.px > width - 230 ? hover.px - 222 : hover.px + 14) : 0;
  const tooltipTop = hover ? Math.max(4, Math.min(hover.py + 14, height - 96)) : 0;

  const domainLabel = domain
    ? `IV scale ${(domain.lo * 100).toFixed(0)}%–${(domain.hi * 100).toFixed(0)}% (5th–95th pctile)`
    : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
        {rights !== 'P' && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-16 rounded-xs"
              style={{ background: rampCssGradient(callRamp) }}
            />
            call IV
          </span>
        )}
        {rights !== 'C' && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-16 rounded-xs"
              style={{ background: rampCssGradient(putRamp) }}
            />
            put IV
          </span>
        )}
        {domainLabel && <span className="text-muted">{domainLabel}</span>}
        {rights === 'both' && <span className="text-muted">▌ call · ▐ put</span>}
        <span className="flex items-center gap-1.5 text-muted">
          <span
            className="inline-block h-2.5 w-2.5 rounded-xs"
            style={{ background: theme.grid }}
          />
          traded, no BS solution
        </span>
      </div>

      <div ref={wrapRef} className="chart-wrap">
        {domain === null ? (
          <p className="p-8 text-center text-muted">
            nothing to plot — no contract in the window had a solvable implied vol
          </p>
        ) : (
          <svg
            ref={svgRef}
            width={width}
            height={height}
            style={{ display: 'block', shapeRendering: 'crispEdges' }}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(null)}
          >
            {cells}
            <line
              x1={ML}
              y1={spotY}
              x2={ML + plotW}
              y2={spotY}
              stroke={theme.ink}
              strokeOpacity={0.45}
            />
            <text
              x={ML + plotW - 4}
              y={spotY - 4}
              textAnchor="end"
              fontSize={10}
              fill={theme.muted}
              stroke={theme.surface}
              strokeWidth={3}
              paintOrder="stroke"
              style={{ shapeRendering: 'auto' }}
            >
              spot {fmtUsd(spotCents)}
            </text>
            {strikesCents.map((strikeCents, strikeIndex) => {
              if (strikeIndex % yLabelStep !== 0) return null;
              const y = MT + (nRows - 1 - strikeIndex) * rowH + rowH / 2 + 3;
              return (
                <text
                  key={strikeCents}
                  x={ML - 6}
                  y={y}
                  textAnchor="end"
                  fontSize={10}
                  fill={theme.muted}
                >
                  {fmtUsd(strikeCents)}
                </text>
              );
            })}
            {expirations.map((expiration, c) => {
              if (c % xLabelStep !== 0) return null;
              const x = ML + c * colW + colW / 2;
              const y = MT + plotH + 12;
              return (
                <text
                  key={expiration.expirationIso}
                  x={x}
                  y={y}
                  fontSize={10}
                  fill={theme.muted}
                  transform={`rotate(45 ${x} ${y})`}
                >
                  {expiration.expirationIso.slice(5)}
                </text>
              );
            })}
            {hover && (
              <rect
                x={ML + hover.c * colW + 0.5}
                y={MT + hover.r * rowH + 0.5}
                width={colW - 1}
                height={rowH - 1}
                fill="none"
                stroke={theme.ink}
                strokeWidth={1.5}
              />
            )}
          </svg>
        )}
        {hover && hoverExpiration && (
          <div
            className="chart-tooltip"
            style={{ display: 'block', left: tooltipLeft, top: tooltipTop }}
          >
            <div className="t">
              {hoverExpiration.expirationIso} · {hoverExpiration.dte}d
              {hoverExpiration.frequency ? ` · ${hoverExpiration.frequency}` : ''}
            </div>
            <div>
              K {fmtUsd(hoverStrike)} · {(((hoverStrike - spotCents) / spotCents) * 100).toFixed(1)}
              % vs spot
            </div>
            {hoverCell ? (
              <>
                <div>
                  <span style={{ color: callRamp(0.7) }}>▌ call</span>{' '}
                  {hoverCell[0] === null ? '—' : `${fmtUsd(hoverCell[0])} · ${fmtIv(hoverCell[1])}`}
                </div>
                <div>
                  <span style={{ color: putRamp(0.7) }}>▐ put</span>{' '}
                  {hoverCell[2] === null ? '—' : `${fmtUsd(hoverCell[2])} · ${fmtIv(hoverCell[3])}`}
                </div>
              </>
            ) : (
              <div className="t">no trades on {data.dateIso}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
