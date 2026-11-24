/**
 * Target chip in a step row: shows "95–100 % · 262–276 W"; ↑/↓ nudges the range live; click opens
 * a small picker (≤ 320 px) to change the target type and values, plus the secondary target.
 */
import type { ReactNode } from 'react';
import type { Sport, Step, Target, ThresholdSnapshot } from '@cadence/core';
import { Popover } from '@/ui';
import { cn } from '@/lib/cn';
import { paceBasis, type UnitPrefs } from '@/lib/units';
import { paceParts, parsePace } from '@/lib/format';
import { defaultTarget, targetKinds, TARGET_KIND_LABEL, type TargetKind } from '../model';
import { MiniField, fmtRange, nudgeTarget, parseRange, targetAbsolute, targetLabel } from './fields';

interface Props {
  step: Step;
  sport: Sport;
  th: ThresholdSnapshot;
  units: UnitPrefs;
  onChange: (patch: Partial<Step>) => void;
}

export function TargetChip({ step, sport, th, units, onChange }: Props) {
  const t = step.target;
  const abs = targetAbsolute(t, sport, th, units);
  const sec = step.secondary;
  return (
    <Popover
      title="Target"
      trigger={
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (!t || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
            e.preventDefault();
            e.stopPropagation();
            onChange({ target: nudgeTarget(t, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 5 : 1)) });
          }}
          aria-label={`Target ${targetLabel(t, sport, units)}${abs ? `, ${abs}` : ''}. Arrow keys adjust.`}
          className={cn(
            'inline-flex h-8 max-w-full min-w-0 items-center gap-2 overflow-hidden rounded-sm px-2 text-left transition-colors duration-(--dur-fast)',
            'hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-focus data-[popup-open]:bg-surface-3',
          )}
        >
          <span className={cn('num truncate text-body', t && t.type !== 'open' ? 'text-fg-1' : 'text-fg-3')}>{targetLabel(t, sport, units)}</span>
          {abs && <span className="num truncate text-body-sm text-fg-3 max-sm:hidden">{abs}</span>}
          {sec && <span className="num truncate text-body-sm text-fg-3 max-md:hidden">· {targetLabel(sec, sport, units)}</span>}
        </button>
      }
    >
      <TargetEditor step={step} sport={sport} th={th} units={units} onChange={onChange} />
    </Popover>
  );
}

function TargetEditor({ step, sport, th, units, onChange }: Props) {
  const t = step.target ?? { type: 'open' as const };
  const kinds = targetKinds(sport);
  const setKind = (k: TargetKind) => {
    if (k === t.type) return;
    onChange({ target: k === 'open' ? undefined : defaultTarget(k, sport, th, step.role === 'active' ? 1 : step.role === 'recovery' ? 0.6 : 0.75, units) });
  };
  const cad = step.secondary?.type === 'cadence' ? step.secondary : undefined;
  return (
    <div className="flex w-72 flex-col gap-3 p-1">
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Target type">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={t.type === k}
            onClick={() => setKind(k)}
            className={cn(
              'h-7 rounded-md px-2.5 text-body-sm transition-colors duration-(--dur-fast)',
              t.type === k ? 'bg-surface-active text-fg-1' : 'text-fg-3 hover:bg-surface-3 hover:text-fg-1',
            )}
          >
            {k === 'pace_pct' && sport === 'swim' ? '% CSS' : TARGET_KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <TargetValues t={t} sport={sport} units={units} onChange={(target) => onChange({ target })} />
      {targetAbsolute(t, sport, th, units) && <div className="num text-body-sm text-fg-3">= {targetAbsolute(t, sport, th, units)}</div>}
      {(sport === 'bike' || sport === 'run') && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-body-sm text-fg-2">Cadence</span>
          {cad ? (
            <span className="flex items-center gap-1">
              <MiniField label="Cadence range" value={[cad.low, cad.high] as [number, number]} format={fmtRange} parse={parseRange} width="w-20" onCommit={([low, high]) => onChange({ secondary: { type: 'cadence', low, high } })} suffix={sport === 'run' ? 'spm' : 'rpm'} />
              <button type="button" className="px-1 text-body-sm text-fg-3 hover:text-fg-1" onClick={() => onChange({ secondary: undefined })}>
                Clear
              </button>
            </span>
          ) : (
            <button type="button" className="text-body-sm text-fg-2 hover:text-fg-1" onClick={() => onChange({ secondary: { type: 'cadence', low: sport === 'run' ? 170 : 85, high: sport === 'run' ? 180 : 95 } })}>
              + Add
            </button>
          )}
        </div>
      )}
      {sport === 'row' && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-body-sm text-fg-2">Stroke rate</span>
          <MiniField
            label="Stroke rate"
            value={[step.row?.strokeRateLow ?? 0, step.row?.strokeRateHigh ?? 0] as [number, number]}
            format={(v) => (v[0] ? fmtRange(v) : '')}
            placeholder="24–26"
            parse={(s): [number, number] | null => (s.trim() ? parseRange(s) : [0, 0])}
            width="w-20"
            onCommit={([a, b]) => onChange({ row: a ? { strokeRateLow: a, strokeRateHigh: b } : undefined })}
            suffix="spm"
          />
        </div>
      )}
    </div>
  );
}

/** Bounds and step for the numeric From/To kinds (values are stored as-is in the domain target). */
const RANGE_SPEC = {
  power_pct: { min: 1, max: 300, step: 1 },
  pace_pct: { min: 1, max: 300, step: 1 },
  hr_pct_lthr: { min: 1, max: 150, step: 1 },
  power_w: { min: 1, max: 2500, step: 5 },
  hr_bpm: { min: 30, max: 240, step: 1 },
} as const;
type RangeKind = keyof typeof RANGE_SPEC;

/** "88" / "88 %" / "88.5" → number within [min, max] (one decimal), else null. */
function parseBound(s: string, min: number, max: number): number | null {
  const m = s.trim().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*%?$/);
  if (!m) return null;
  const v = Math.round(+m[1] * 10) / 10;
  return v >= min && v <= max ? v : null;
}

/** Two labelled fields side by side: From and To (the shared pattern of every range target). */
function FromTo({ name, from, to }: { name: string; from: ReactNode; to: ReactNode }) {
  return (
    <div role="group" aria-label={name} className="grid grid-cols-2 gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-label text-fg-3" aria-hidden>
          From
        </span>
        {from}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-label text-fg-3" aria-hidden>
          To
        </span>
        {to}
      </div>
    </div>
  );
}

const fieldProps = { boxed: true, align: 'left' as const, width: 'w-full min-w-0', className: 'w-full' };

function TargetValues({ t, sport, units, onChange }: { t: Target; sport: Sport; units: UnitPrefs; onChange: (t: Target | undefined) => void }) {
  switch (t.type) {
    case 'power_pct':
    case 'pace_pct':
    case 'hr_pct_lthr':
    case 'power_w':
    case 'hr_bpm': {
      const spec = RANGE_SPEC[t.type as RangeKind];
      const unit = t.type === 'power_w' ? 'W' : t.type === 'hr_bpm' ? 'bpm' : t.type === 'power_pct' ? '% FTP' : t.type === 'hr_pct_lthr' ? '% LTHR' : sport === 'swim' ? '% CSS' : '% thr';
      // The edited bound wins; if it crosses the other one, the other follows (stored low ≤ high).
      const commit = (which: 'From' | 'To', x: number) =>
        onChange(which === 'From' ? { ...t, low: x, high: Math.max(x, t.high) } : { ...t, low: Math.min(x, t.low), high: x });
      const nudge = (v: number, d: 1 | -1, big: boolean) => Math.min(spec.max, Math.max(spec.min, v + spec.step * (big ? 5 : 1) * d));
      const field = (which: 'From' | 'To', v: number) => (
        <MiniField
          {...fieldProps}
          label={`Target ${which.toLowerCase()} (${unit})`}
          value={v}
          format={String}
          parse={(s) => parseBound(s, spec.min, spec.max)}
          nudge={nudge}
          onCommit={(x) => commit(which, x)}
          suffix={unit}
        />
      );
      return <FromTo name={`Target range, ${unit}`} from={field('From', t.low)} to={field('To', t.high)} />;
    }
    case 'pace': {
      // Domain: lowMps = the slower bound, highMps = the faster one. From = slower pace, To = faster
      // (e.g. From 5:10 To 4:55 /km). The edited bound wins; if it crosses the other, the other follows.
      const unitLabel = paceParts(t.highMps, sport, units).unit;
      const fmt = (mps: number) => paceParts(mps, sport, units).value;
      const commit = (which: 'From' | 'To', x: number) =>
        onChange(which === 'From' ? { type: 'pace', lowMps: x, highMps: Math.max(x, t.highMps) } : { type: 'pace', lowMps: Math.min(x, t.lowMps), highMps: x });
      // ↑/↓ moves the shown clock by 1 s (Shift 5 s), like any number field.
      const { meters } = paceBasis(sport, units);
      const nudge = (mps: number, d: 1 | -1, big: boolean) => meters / Math.max(1, Math.round(meters / mps) + d * (big ? 5 : 1));
      const field = (which: 'From' | 'To', v: number) => (
        <MiniField
          {...fieldProps}
          label={`Pace ${which.toLowerCase()} (min:sec ${unitLabel})`}
          value={v}
          format={fmt}
          placeholder="m:ss"
          parse={(s) => {
            const mps = parsePace(s, sport, units);
            return mps && Number.isFinite(mps) ? mps : null;
          }}
          nudge={nudge}
          onCommit={(x) => commit(which, x)}
          suffix={unitLabel}
        />
      );
      return <FromTo name={`Pace range, min:sec ${unitLabel}`} from={field('From', t.lowMps)} to={field('To', t.highMps)} />;
    }
    case 'ramp': {
      // A ramp keeps its direction (a cool-down ramps down), so From/To are not sorted.
      const unit = t.basis === 'power_pct' ? '% FTP' : t.basis === 'hr_pct_lthr' ? '% LTHR' : sport === 'swim' ? '% CSS' : '% thr';
      const nudge = (v: number, d: 1 | -1, big: boolean) => Math.min(300, Math.max(1, v + (big ? 5 : 1) * d));
      const field = (which: 'From' | 'To', v: number, patch: (x: number) => Target) => (
        <MiniField {...fieldProps} label={`Ramp ${which.toLowerCase()} (${unit})`} value={v} format={String} parse={(s) => parseBound(s, 1, 300)} nudge={nudge} onCommit={(x) => onChange(patch(x))} suffix={unit} />
      );
      return <FromTo name={`Ramp, ${unit}`} from={field('From', t.from, (from) => ({ ...t, from }))} to={field('To', t.to, (to) => ({ ...t, to }))} />;
    }
    case 'rpe':
      return (
        <label className="flex items-center justify-between gap-2">
          <span className="text-body-sm text-fg-2">RPE</span>
          <MiniField
            boxed
            label="RPE"
            value={[t.low, t.high] as [number, number]}
            format={fmtRange}
            parse={(s) => {
              const r = parseRange(s);
              return r ? ([Math.max(1, Math.min(10, r[0])), Math.max(1, Math.min(10, r[1]))] as [number, number]) : null;
            }}
            nudge={([a, b], d) => [Math.min(10, Math.max(1, a + d)), Math.min(10, Math.max(1, b + d))] as [number, number]}
            width="w-20"
            onCommit={([low, high]) => onChange({ ...t, low, high })}
            suffix="/10"
          />
        </label>
      );
    case 'hr_zone':
      return (
        <div className="flex items-center justify-between gap-2">
          <span className="text-body-sm text-fg-2">Zone</span>
          <span className="flex gap-1" role="radiogroup" aria-label="Heart-rate zone">
            {[1, 2, 3, 4, 5].map((z) => (
              <button
                key={z}
                type="button"
                role="radio"
                aria-checked={t.zone === z}
                onClick={() => onChange({ type: 'hr_zone', zone: z })}
                className={cn('h-7 w-8 rounded-md text-body-sm transition-colors duration-(--dur-fast)', t.zone === z ? 'bg-surface-active text-fg-1' : 'text-fg-3 hover:bg-surface-3 hover:text-fg-1')}
              >
                Z{z}
              </button>
            ))}
          </span>
        </div>
      );
    default:
      return <p className="text-body-sm text-fg-3">No target — ride or run by feel.</p>;
  }
}
