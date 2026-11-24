/**
 * WeightChart — body-weight readings (small fg-4 dots) under the smoothed trend line (series-1),
 * with an optional dashed goal reference. Same idiom as the WellnessChart weight panel, given room:
 * one panel, ≤ 3 gridlines, end label on the trend, shared crosshair + tooltip.
 */
import { useCallback, useId, useMemo, useRef } from 'react';
import { curveMonotoneX, line } from 'd3-shape';
import { scaleLinear } from 'd3-scale';
import { bisectCenter } from 'd3-array';
import type { LocalDate, WeightPoint } from '@cadence/core';
import { ChartDefs, useChartDefs } from './core/ChartDefs';
import { ChartFrame } from './core/ChartFrame';
import { dateTicks, thinTicks } from './core/Axis';
import { EndLabels } from './core/EndLabels';
import { Reveal } from './core/animated';
import { T, TXT } from './core/tokens';
import { useChartSize } from './core/useChartSize';
import { useHoverSync, useHoverValue, type HoverSync } from './core/hover';
import { useChartPointer, type PointerAnchor } from './core/useChartPointer';
import { ChartTooltip, CrosshairDot, CrosshairRule, TooltipBody } from './core/Tooltip';
import { dateMs, fmtDayLong, fmtNum } from './format';

export interface WeightChartProps {
  series: WeightPoint[];
  goalKg?: number;
  height?: number;
  sync?: HoverSync<LocalDate>;
  loading?: boolean;
  /** Format kg for display (units preference). Defaults to "84.2 kg". */
  format?: (kg: number) => string;
  className?: string;
}

const defaultFmt = (kg: number) => `${fmtNum(kg, 1)} kg`;

export function WeightChart(props: WeightChartProps) {
  const { series, loading, height = 240, className, format = defaultFmt } = props;
  const [ref, size] = useChartSize<HTMLDivElement>();
  const last = series.at(-1);
  return (
    <div className={`min-w-0 ${className ?? ''}`}>
      <ChartFrame
        summary={last ? `Weight over ${series.length} days. Trend ${format(last.trendKg)}.` : 'Weight: no data'}
        loading={loading}
        empty={series.length < 2}
        emptyHint="Log your weight below (or from the Day page) — the trend appears after two readings."
        height={height}
        table={{ caption: 'Daily weight', columns: ['Date', 'Reading kg', 'Trend kg'], rows: series.filter((p) => p.weightKg != null).slice(-120).map((p) => [p.date, fmtNum(p.weightKg, 1), fmtNum(p.trendKg, 1)]) }}
      >
        <div ref={ref} className="w-full">
          {size.width > 0 && <Inner {...props} format={format} height={height} width={size.width} />}
        </div>
      </ChartFrame>
    </div>
  );
}

function Inner({ series, goalKg, height = 240, width, sync: ext, format = defaultFmt }: WeightChartProps & { width: number }) {
  const defs = useChartDefs();
  const id = useId();
  const sync = useHoverSync<LocalDate>(ext);
  const compact = width < 480;
  const L = { left: 40, right: compact ? 8 : 96, top: 12, bottom: 28 };
  const plotW = Math.max(10, width - L.left - L.right);
  const plotH = Math.max(40, height - L.top - L.bottom);
  const ms = useMemo(() => series.map((p) => dateMs(p.date)), [series]);
  const x0 = ms[0];
  const x1 = ms[ms.length - 1];
  const X = useCallback((t: number) => L.left + ((t - x0) / (x1 - x0 || 1)) * plotW, [L.left, x0, x1, plotW]);

  const vals = [...series.map((p) => p.trendKg), ...series.map((p) => p.weightKg).filter((v): v is number => v != null), ...(goalKg != null ? [goalKg] : [])];
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const pad = (hi - lo) * 0.12 || 1;
  lo -= pad;
  hi += pad;
  const bot = L.top + plotH;
  const Y = (v: number) => bot - ((v - lo) / (hi - lo)) * plotH;
  const ticks = scaleLinear().domain([lo, hi]).ticks(3).filter((v) => Y(v) > L.top + 4 && Y(v) < bot - 4);
  const trendPath = line<WeightPoint>().x((_, i) => X(ms[i])).y((p) => Y(p.trendKg)).curve(curveMonotoneX)(series) ?? '';

  const keys = useMemo(() => series.map((p) => p.date), [series]);
  const keyAt = useCallback(
    (x: number) => {
      if (x < L.left - 4 || x > L.left + plotW + 4) return null;
      const t = x0 + ((x - L.left) / plotW) * (x1 - x0);
      return keys[Math.max(0, Math.min(keys.length - 1, bisectCenter(ms, t)))];
    },
    [L.left, plotW, x0, x1, keys, ms],
  );
  const svgRef = useRef<SVGSVGElement>(null);
  const { handlers, live, anchor } = useChartPointer<LocalDate>({
    keys,
    keyAt,
    sync,
    id,
    initialKey: keys[keys.length - 1],
    describe: (k) => {
      const p = series[keys.indexOf(k)];
      return `${fmtDayLong(k)}: ${p.weightKg != null ? `reading ${format(p.weightKg)}, ` : ''}trend ${format(p.trendKg)}`;
    },
  });
  const xTicks = thinTicks(dateTicks(X, x0, x1, plotW));
  const lastP = series.at(-1);

  return (
    <div className="relative">
      <svg ref={svgRef} width={width} height={height} className="block touch-pan-y select-none overflow-visible rounded-xs focus-visible:outline-offset-4" role="group" aria-roledescription="chart" aria-label="Body weight trend" tabIndex={0} {...handlers}>
        <ChartDefs ids={defs} />
        {ticks.map((v) => (
          <g key={v} aria-hidden>
            <line x1={L.left} x2={L.left + plotW} y1={Y(v)} y2={Y(v)} style={{ stroke: T.line1 }} shapeRendering="crispEdges" />
            <text x={L.left - 10} y={Y(v)} textAnchor="end" dominantBaseline="central" style={{ ...TXT, fill: T.fg3 }}>
              {v}
            </text>
          </g>
        ))}
        {goalKg != null && (
          <g aria-hidden>
            <line x1={L.left} x2={L.left + plotW} y1={Y(goalKg)} y2={Y(goalKg)} strokeLinecap="round" style={{ stroke: T.fg3, strokeDasharray: '2 4' }} />
            <text x={L.left + 4} y={Y(goalKg) - 6} style={{ ...TXT, fill: T.fg3 }}>
              Goal {format(goalKg)}
            </text>
          </g>
        )}
        <Reveal id={defs.id('wt')} x={L.left} y={L.top - 4} width={plotW} height={plotH + 8}>
          {series.map((p, i) => (p.weightKg == null ? null : <circle key={p.date} cx={X(ms[i])} cy={Y(p.weightKg)} r={2.25} style={{ fill: T.fg4, opacity: 0.9 }} />))}
          <path d={trendPath} fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: T.series1, strokeWidth: 2 }} />
        </Reveal>
        {!compact && lastP && <EndLabels labels={[{ id: 'trend', y: Y(lastP.trendKg), value: format(lastP.trendKg), name: 'trend', tone: 'series1' }]} x={L.left + plotW + 8} top={L.top} bottom={bot} />}
        <g aria-hidden>
          {xTicks.map((t) => (
            <text key={t.key} x={t.pos} y={height - 14} textAnchor="middle" dominantBaseline="hanging" style={{ ...TXT, fill: t.strong ? T.fg2 : T.fg3 }}>
              {t.label}
            </text>
          ))}
        </g>
        <Overlay sync={sync} keys={keys} ms={ms} X={X} Y={Y} series={series} top={L.top} bot={bot} />
      </svg>
      <Tip sync={sync} keys={keys} ms={ms} X={X} series={series} width={width} anchor={anchor} boundsRef={svgRef} format={format} />
      <span className="sr-only" aria-live="polite">
        {live}
      </span>
    </div>
  );
}

function Overlay({ sync, keys, ms, X, Y, series, top, bot }: { sync: HoverSync<LocalDate>; keys: LocalDate[]; ms: number[]; X: (t: number) => number; Y: (v: number) => number; series: WeightPoint[]; top: number; bot: number }) {
  const k = useHoverValue(sync);
  const i = k == null ? -1 : keys.indexOf(k);
  if (i < 0) return null;
  const x = X(ms[i]);
  return (
    <g pointerEvents="none">
      <CrosshairRule x={Math.round(x) + 0.5} y0={top} y1={bot} />
      <CrosshairDot x={x} y={Y(series[i].trendKg)} tone="series1" />
    </g>
  );
}

function Tip({ sync, keys, ms, X, series, width, anchor, boundsRef, format }: { sync: HoverSync<LocalDate>; keys: LocalDate[]; ms: number[]; X: (t: number) => number; series: WeightPoint[]; width: number; anchor: PointerAnchor; boundsRef: React.RefObject<SVGSVGElement | null>; format: (kg: number) => string }) {
  const k = useHoverValue(sync);
  const i = k == null ? -1 : keys.indexOf(k);
  const p = series[Math.max(0, i)];
  return (
    <ChartTooltip x={X(ms[Math.max(0, i)] ?? 0)} y={8} containerWidth={width} visible={i >= 0} anchor={anchor} boundsRef={boundsRef}>
      <TooltipBody
        title={k ? fmtDayLong(k) : ''}
        rows={p ? [{ label: 'Reading', value: p.weightKg != null ? format(p.weightKg) : '—', muted: p.weightKg == null }, { label: 'Trend', value: format(p.trendKg) }] : []}
      />
    </ChartTooltip>
  );
}
