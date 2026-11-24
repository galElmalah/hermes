/**
 * Workout execution (plan vs actual, step by step) — shared by the activity page and the planned
 * workout page. Data: `ExecutionAnalysis` (docs/MOBILE_API.md §4).
 *
 *   <ExecutionSummary x={a.execution} />          score · state · one-line summary · method note
 *   <ExecutionStrip x={a.execution} />            per-step deviation bars (up = harder/longer, down = easier/shorter)
 *   <ExecutionSteps x={a.execution} sport="run" /> the per-step list
 *
 * Over vs under is told by direction (bars up / down), a glyph (▲ / ▼) and a word — colour
 * (status `serious` for over, data blue for under, `good` on target) only reinforces it. Text
 * stays fg-* (DESIGN_V2 §8).
 */
import type { ExecutionAnalysis, ExecutionStep, ExecutionVerdict, Sport } from '@cadence/core';
import { useId, useState } from 'react';
import { CollapseBody, CollapseToggle, useSectionOpen } from '../Section';
import { cn } from '@/lib/cn';
import { distanceParts, formatDuration, formatNumber, paceParts, speedParts } from '@/lib/format';
import { PACE_SPORTS, useUnits } from '@/lib/units';
import { ComplianceGlyph, complianceLabel } from './Compliance';
import { STATUS_COLOR } from './dataColor';

export const VERDICT_COLOR: Record<ExecutionVerdict, string> = {
  on_target: STATUS_COLOR.good,
  over: STATUS_COLOR.serious,
  under: 'var(--color-series-1)',
  skipped: STATUS_COLOR.critical,
  extra: 'var(--color-fg-3)',
};

export const VERDICT_LABEL: Record<ExecutionVerdict, string> = {
  on_target: 'On target',
  over: 'Over',
  under: 'Under',
  skipped: 'Skipped',
  extra: 'Extra',
};

/** 12px verdict glyph: ● on target · ▲ over · ▼ under · ⊘ skipped · ＋ extra. */
export function VerdictGlyph({ verdict, size = 12, className }: { verdict: ExecutionVerdict; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 12 12" width={size} height={size} className={cn('shrink-0', className)} style={{ color: VERDICT_COLOR[verdict] }} aria-hidden>
      {verdict === 'on_target' && <circle cx={6} cy={6} r={4.75} fill="currentColor" />}
      {verdict === 'over' && <path d="M6 1.6 10.8 10H1.2Z" fill="currentColor" />}
      {verdict === 'under' && <path d="M6 10.4 1.2 2h9.6Z" fill="currentColor" />}
      {verdict === 'skipped' && (
        <>
          <circle cx={6} cy={6} r={4.5} fill="none" stroke="currentColor" strokeWidth={1.4} />
          <path d="M2.8 9.2 9.2 2.8" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
        </>
      )}
      {verdict === 'extra' && <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />}
    </svg>
  );
}

const METHOD_NOTE: Record<ExecutionAnalysis['method'], string> = {
  laps: 'Matched lap by lap',
  streams: 'Matched on the recording',
  session: 'Totals only',
};

/** Score, state, summary and the honest small print (method + confidence). */
export function ExecutionSummary({ x, className }: { x: ExecutionAnalysis; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-4 md:flex-row md:items-start md:gap-8', className)}>
      <div className="flex shrink-0 items-baseline gap-1.5" aria-label={`Adherence ${x.score} out of 100`}>
        <span className="text-stat-lg text-fg-1 tabular-nums">{x.score}</span>
        <span className="text-body text-fg-3">/ 100 adherence</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="inline-flex items-center gap-2 text-body-sm">
          <ComplianceGlyph state={x.state} size={14} />
          <span className="font-medium text-fg-1">{complianceLabel(x.state)}</span>
        </span>
        <p className="text-body-lg text-fg-1">{x.summary}</p>
        <p className="text-body-sm text-fg-3">
          {METHOD_NOTE[x.method]}
          {x.method !== 'session' && ` · ${x.confidence} confidence`} · {x.note}
        </p>
      </div>
    </div>
  );
}

/** Signed misfit of a step for the strip: + harder/longer, − easier/shorter, size from its score. */
function misfit(s: ExecutionStep): number {
  if (s.verdict === 'on_target' || s.score == null) return 0;
  const m = Math.max(0.12, (100 - s.score) / 100);
  return s.verdict === 'over' ? m : s.verdict === 'under' ? -m : 0;
}

/**
 * Per-step deviation strip: one column per step (width ∝ its duration), a bar up for over, down
 * for under, a small mark on the line for on target, a hatched ghost for skipped, a dotted
 * outline for extra time. Hover / focus a column to read it; `onHover` syncs a list.
 */
export function ExecutionStrip({ x, height = 80, hovered, onHover, className }: { x: ExecutionAnalysis; height?: number; hovered?: number | null; onHover?: (i: number | null) => void; className?: string }) {
  const steps = x.steps;
  if (!steps.length) return null;
  // √duration: long steady steps stay widest without squeezing short reps into slivers.
  const dur = (s: ExecutionStep) => Math.sqrt(Math.max(20, s.actual?.durationSec ?? s.planned?.durationSec ?? 60));
  const total = steps.reduce((t, s) => t + dur(s), 0);
  const mid = height / 2;
  const amp = mid - 10;
  let acc = 0;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex justify-between text-label text-fg-3">
        <span className="inline-flex items-center gap-1">
          <VerdictGlyph verdict="over" size={9} /> Harder or longer
        </span>
      </div>
      <svg width="100%" height={height} viewBox={`0 0 1000 ${height}`} preserveAspectRatio="none" role="img" aria-label={`Step by step: ${x.counts.onTarget} on target, ${x.counts.over} over, ${x.counts.under} under, ${x.counts.skipped} skipped`} className="block overflow-visible">
        <defs>
          <pattern id="exec-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="2" height="6" fill="var(--color-critical)" opacity="0.5" />
          </pattern>
        </defs>
        <line x1={0} x2={1000} y1={mid} y2={mid} stroke="var(--color-line-2)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {steps.map((s, i) => {
          const w = (dur(s) / total) * 1000;
          const x0 = acc;
          acc += w;
          const gap = Math.min(4, w * 0.15);
          const bx = x0 + gap / 2;
          const bw = Math.max(1, w - gap);
          const m = misfit(s);
          const h = Math.abs(m) * amp;
          const focus = hovered === i;
          const color = VERDICT_COLOR[s.verdict];
          return (
            <g key={i} onPointerEnter={() => onHover?.(i)} onPointerLeave={() => onHover?.(null)} opacity={hovered != null && !focus ? 0.45 : 1} style={{ transition: 'opacity var(--dur-fast)' }}>
              <title>{`${s.label}: ${VERDICT_LABEL[s.verdict]}${s.deviation ? ` — ${s.deviation}` : ''}`}</title>
              <rect x={x0} y={0} width={w} height={height} fill="transparent" />
              {s.verdict === 'skipped' && <rect x={bx} y={mid - amp * 0.5} width={bw} height={amp} fill="url(#exec-hatch)" rx={2} />}
              {s.verdict === 'extra' && <rect x={bx} y={mid - 6} width={bw} height={12} fill="none" stroke={color} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" rx={2} />}
              {s.verdict === 'on_target' && <rect x={bx} y={mid - 2} width={bw} height={4} fill={color} rx={1.5} />}
              {(s.verdict === 'over' || s.verdict === 'under') && <rect x={bx} y={m > 0 ? mid - h : mid} width={bw} height={Math.max(2, h)} fill={color} rx={2} />}
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between text-label text-fg-3">
        <span className="inline-flex items-center gap-1">
          <VerdictGlyph verdict="under" size={9} /> Easier or shorter
        </span>
      </div>
    </div>
  );
}

function metricValue(s: ExecutionStep, sport: Sport, units: ReturnType<typeof useUnits>): string | null {
  const i = s.intensity;
  const a = s.actual;
  const metric = i?.metric ?? (a?.avgPower != null ? 'power' : a?.avgSpeedMps != null ? 'speed' : a?.avgHr != null ? 'hr' : null);
  const v = i?.actual ?? (metric === 'power' ? a?.avgPower : metric === 'speed' ? a?.avgSpeedMps : metric === 'hr' ? a?.avgHr : null);
  if (v == null || !metric) return null;
  if (metric === 'speed') {
    const p = PACE_SPORTS.has(sport) ? paceParts(v, sport, units) : speedParts(v, units);
    return `${p.value} ${p.unit}`;
  }
  if (metric === 'power') return `${formatNumber(v)} W`;
  if (metric === 'hr') return `${formatNumber(v)} bpm`;
  return `${formatNumber(v)} ${sport === 'run' ? 'spm' : 'rpm'}`;
}

function amountText(s: ExecutionStep, sport: Sport, units: ReturnType<typeof useUnits>, which: 'planned' | 'actual'): string | null {
  if (which === 'planned') {
    const p = s.planned;
    if (!p) return null;
    if (p.measure === 'distance' && p.distanceM != null) {
      const d = distanceParts(p.distanceM, sport, units);
      return `${d.value} ${d.unit}`;
    }
    if (p.measure === 'lap_button') return 'until lap';
    return p.durationSec != null ? formatDuration(p.durationSec, 'hms') : null;
  }
  const a = s.actual;
  if (!a) return null;
  if (s.duration?.basis === 'distance' && a.distanceM != null) {
    const d = distanceParts(a.distanceM, sport, units);
    return `${d.value} ${d.unit}`;
  }
  return formatDuration(a.durationSec, 'hms');
}

/** The per-step list: planned (amount @ target) → actual, verdict and signed deviation. */
export function ExecutionSteps({ x, sport, hovered, onHover, className }: { x: ExecutionAnalysis; sport: Sport; hovered?: number | null; onHover?: (i: number | null) => void; className?: string }) {
  const units = useUnits();
  return (
    <ol className={cn('flex flex-col', className)} aria-label="Steps, planned and done">
      {x.steps.map((s, i) => {
        const planned = amountText(s, sport, units, 'planned');
        const actual = amountText(s, sport, units, 'actual');
        const value = metricValue(s, sport, units);
        return (
          <li
            key={i}
            onPointerEnter={() => onHover?.(i)}
            onPointerLeave={() => onHover?.(null)}
            className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 border-b border-line-1 py-2.5 transition-colors duration-(--dur-fast) md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_7rem_2.5rem] md:items-center', hovered === i && 'bg-surface-1')}
          >
            <div className="min-w-0">
              <div className={cn('truncate text-body', s.verdict === 'skipped' ? 'text-fg-3 line-through decoration-fg-4' : 'text-fg-1')}>{s.label}</div>
              <div className="truncate text-body-sm text-fg-3">
                {s.planned ? [planned, s.planned.targetText].filter(Boolean).join(' @ ') || '—' : 'Not in the plan'}
              </div>
            </div>
            <div className="col-start-2 row-start-1 flex items-center justify-end gap-1.5 text-body-sm text-fg-2 md:col-start-3">
              <VerdictGlyph verdict={s.verdict} />
              <span className={cn(s.verdict === 'on_target' ? 'text-fg-2' : 'font-medium text-fg-1')}>{VERDICT_LABEL[s.verdict]}</span>
            </div>
            <div className="col-span-2 min-w-0 text-body-sm md:col-span-1 md:col-start-2 md:row-start-1">
              {s.actual && (
                <span className="text-fg-1 tabular-nums">
                  {[actual, value].filter(Boolean).join(' · ')}
                </span>
              )}
              {s.deviation && (
                <span className={cn('block text-fg-2', !s.actual && 'text-fg-3')}>
                  {s.deviation}
                </span>
              )}
            </div>
            <div className="hidden text-right text-body-sm text-fg-3 tabular-nums md:block">{s.score ?? ''}</div>
          </li>
        );
      })}
    </ol>
  );
}

/** Planned vs actual totals in one quiet line ("Time 59:18 of 55:00 · Distance 8.46 of 8.62 km · Load 103 of 93"). */
export function ExecutionTotals({ x, sport, className }: { x: ExecutionAnalysis; sport: Sport; className?: string }) {
  const units = useUnits();
  const parts: { label: string; actual: string; planned: string }[] = [];
  if (x.planned.durationSec && x.actual.durationSec != null) parts.push({ label: 'Time', actual: formatDuration(x.actual.durationSec, 'hms'), planned: formatDuration(x.planned.durationSec, 'hms') });
  if (x.planned.distanceM && x.actual.distanceM != null) {
    const a = distanceParts(x.actual.distanceM, sport, units);
    const p = distanceParts(x.planned.distanceM, sport, units);
    parts.push({ label: 'Distance', actual: a.value, planned: `${p.value} ${p.unit}` });
  }
  if (x.planned.load && x.actual.load != null) parts.push({ label: 'Load', actual: formatNumber(x.actual.load), planned: formatNumber(x.planned.load) });
  if (!parts.length) return null;
  return (
    <dl className={cn('flex flex-wrap gap-x-6 gap-y-1 text-body-sm', className)}>
      {parts.map((p) => (
        <div key={p.label} className="flex items-baseline gap-1.5">
          <dt className="text-fg-3">{p.label}</dt>
          <dd className="text-fg-1 tabular-nums">
            {p.actual} <span className="text-fg-3">of {p.planned}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The strip (always shown: the at-a-glance over/under per step) and the per-step list under a
 * collapsible "Step by step" header (closed on phones by default, remembered per `storageKey`).
 */
export function StepByStep({ x, sport, storageKey, className }: { x: ExecutionAnalysis; sport: Sport; storageKey: string; className?: string }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [open, setOpen] = useSectionOpen({ key: storageKey, phone: false, desktop: true });
  const id = `steps-${useId().replace(/:/g, '')}`;
  if (!x.steps.length) return null;
  const off = x.counts.over + x.counts.under + x.counts.skipped;
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <ExecutionStrip x={x} hovered={hovered} onHover={setHovered} />
      <div>
        <div className="flex">
        <CollapseToggle open={open} onToggle={() => setOpen(!open)} controls={id}>
          <span className="flex items-baseline gap-2">
            <span>Step by step</span>
            <span className="text-body-sm font-normal text-fg-3">
              {x.counts.onTarget} on target{off ? ` · ${off} off` : ''}
            </span>
          </span>
        </CollapseToggle>
        </div>
        <CollapseBody open={open} id={id}>
          <ExecutionSteps x={x} sport={sport} hovered={hovered} onHover={setHovered} className="mt-2" />
        </CollapseBody>
      </div>
    </div>
  );
}
