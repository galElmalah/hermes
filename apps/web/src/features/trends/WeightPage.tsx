/** /trends/weight — body-weight trend, quick log, goal and history. */
import type { LocalDate, WeightGoalProgress } from '@cadence/core';
import { addDays } from '@cadence/core/time';
import { Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { WeightChart, createHoverSync, type HoverSync } from '@/charts';
import { formatDateMedium, formatNumber, formatWeight } from '@/lib/format';
import { useClearWeightGoal, useLogWeight, useSetWeightGoal, useWeight } from '@/lib/queries/weight';
import { KG_PER_LB, useUnits } from '@/lib/units';
import { Button, DatePicker, IconButton, NumberField, Segmented, StatRow, StatTile, toast } from '@/ui';
import { useApiToday, type TrendRange } from './data';
import { ChartCard, InlineError, TrendsFrame, useTrendsSearch } from './shared';

const W_RANGES: { value: TrendRange; label: string; days: number }[] = [
  { value: '6w', label: '6W', days: 42 },
  { value: '3m', label: '90D', days: 90 },
  { value: '6m', label: '6M', days: 182 },
  { value: '1y', label: '1Y', days: 365 },
];

const STATUS_COPY: Record<WeightGoalProgress['status'], string> = {
  reached: 'Goal reached',
  on_track: 'On track',
  behind: 'Behind schedule',
  wrong_direction: 'Trending the wrong way',
  no_data: 'Not enough readings yet',
};

/** Weight input/display in the athlete's unit system; storage is always kg. */
function useWeightUnits() {
  const units = useUnits();
  const imperial = units.system === 'imperial';
  return {
    units,
    unit: imperial ? 'lb' : 'kg',
    toDisplay: (kg: number) => (imperial ? kg / KG_PER_LB : kg),
    toKg: (v: number) => (imperial ? v * KG_PER_LB : v),
    fmt: (kg: number) => formatWeight(kg, units),
    fmtDelta: (kg: number) => `${kg > 0 ? '+' : kg < 0 ? '−' : '±'}${formatWeight(Math.abs(kg), units)}`,
  };
}

export function TrendsWeightPage() {
  const { search, set } = useTrendsSearch();
  const range = W_RANGES.some((r) => r.value === search.range) ? search.range! : '3m';
  const days = W_RANGES.find((r) => r.value === range)!.days;
  const { today } = useApiToday();
  const q = useWeight(today ? addDays(today, -(days - 1)) : undefined, today);
  const sync = useMemo(() => createHoverSync<string>(), []);
  const w = useWeightUnits();
  const s = q.data;
  const goal = s?.goal;

  return (
    <TrendsFrame
      title="Weight"
      back
      eyebrow={s?.latest ? `Last reading ${w.fmt(s.latest.weightKg)} · ${formatDateMedium(s.latest.date)}` : 'Log a reading to start your trend'}
      toolbar={<Segmented aria-label="Range" size="sm" value={range} onValueChange={(r) => set({ range: r })} options={W_RANGES.map((r) => ({ value: r.value, label: r.label }))} />}
    >
      <ChartCard title="Trend" question="Dots are your scale readings; the line is a smoothed trend that ignores day-to-day water swings. Judge progress by the line.">
        {q.isError ? <InlineError onRetry={() => q.refetch()} /> : <WeightChart series={s?.series ?? []} goalKg={goal?.targetKg} loading={!s} sync={sync as HoverSync<LocalDate>} format={w.fmt} />}
      </ChartCard>

      <StatRow columns={4}>
        <StatTile label="Trend" value={s?.trendKg ?? null} format={w.fmt} hint={s?.latest ? `latest reading ${w.fmt(s.latest.weightKg)}` : 'no readings'} />
        <StatTile label="Last 7 days" value={s?.change7dKg ?? null} format={w.fmtDelta} hint="change in trend" />
        <StatTile label="Rate" value={s?.ratePerWeekKg ?? null} format={(x) => `${w.fmtDelta(x)}/wk`} hint="28-day fit" />
        <StatTile
          label="To goal"
          value={goal ? Math.abs(goal.remainingKg) : null}
          format={w.fmt}
          hint={goal ? `${STATUS_COPY[goal.status]}${goal.projectedDate ? ` · ~${formatDateMedium(goal.projectedDate, true)}` : ''}` : 'no goal set'}
        />
      </StatRow>

      <div className="grid gap-8 md:grid-cols-2">
        {today && <LogCard today={today} latestKg={s?.latest?.weightKg} />}
        {today && <GoalCard today={today} goal={goal} trendKg={s?.trendKg} />}
      </div>

      {s && <History series={s.series} />}
    </TrendsFrame>
  );
}

function LogCard({ today, latestKg }: { today: LocalDate; latestKg?: number }) {
  const w = useWeightUnits();
  const log = useLogWeight();
  const [date, setDate] = useState<LocalDate>(today);
  const [value, setValue] = useState<number | null>(latestKg != null ? Math.round(w.toDisplay(latestKg) * 10) / 10 : null);
  useEffect(() => {
    if (value == null && latestKg != null) setValue(Math.round(w.toDisplay(latestKg) * 10) / 10);
  }, [latestKg]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = () => {
    if (value == null) return;
    log.mutate(
      { date, weightKg: Math.round(w.toKg(value) * 100) / 100 },
      { onSuccess: () => toast.success(`Logged ${w.fmt(w.toKg(value))} for ${formatDateMedium(date)}`), onError: (e) => toast.error(e.message) },
    );
  };
  return (
    <ChartCard title="Log weight" question="Weigh in the morning, after the bathroom, before eating — same conditions every time.">
      <div className="flex flex-wrap items-end gap-3">
        <NumberField label="Weight" value={value} unit={w.unit} min={w.toDisplay(25)} max={w.toDisplay(300)} step={0.1} format={{ maximumFractionDigits: 1 }} onValueChange={setValue} />
        <DatePicker label="Date" value={date} max={today} onValueChange={(d) => setDate(d as LocalDate)} />
        <Button variant="primary" onClick={submit} loading={log.isPending} disabled={value == null}>
          Log
        </Button>
      </div>
    </ChartCard>
  );
}

function GoalCard({ today, goal, trendKg }: { today: LocalDate; goal?: WeightGoalProgress; trendKg?: number }) {
  const w = useWeightUnits();
  const save = useSetWeightGoal();
  const clear = useClearWeightGoal();
  const [target, setTarget] = useState<number | null>(goal ? Math.round(w.toDisplay(goal.targetKg) * 10) / 10 : null);
  const [date, setDate] = useState<LocalDate | null>(goal?.targetDate ?? null);
  useEffect(() => {
    if (goal) {
      setTarget(Math.round(w.toDisplay(goal.targetKg) * 10) / 10);
      setDate(goal.targetDate ?? null);
    }
  }, [goal?.targetKg, goal?.targetDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Preview the weekly rate this target implies before saving.
  const impliedRate = target != null && date && trendKg != null ? (w.toKg(target) - trendKg) / ((new Date(date).getTime() - new Date(today).getTime()) / (7 * 86_400_000)) : null;
  const aggressive = impliedRate != null && trendKg != null && Math.abs(impliedRate) > trendKg * 0.01;

  const submit = () => {
    if (target == null) return;
    save.mutate({ targetKg: Math.round(w.toKg(target) * 10) / 10, ...(date ? { targetDate: date } : {}) }, { onSuccess: () => toast.success('Goal saved'), onError: (e) => toast.error(e.message) });
  };
  return (
    <ChartCard
      title="Goal"
      question={
        goal
          ? `From ${w.fmt(goal.startKg)} on ${formatDateMedium(goal.startDate, true)} → ${w.fmt(goal.targetKg)}${goal.targetDate ? ` by ${formatDateMedium(goal.targetDate, true)}` : ''}. ${goal.progressPct}% of the way.${goal.requiredRatePerWeekKg != null ? ` Needs ${w.fmtDelta(goal.requiredRatePerWeekKg)}/wk from here.` : ''}`
          : 'Set a target to see progress, the weekly rate it needs and when you will get there.'
      }
      actions={
        goal && (
          <Button size="sm" variant="ghost" loading={clear.isPending} onClick={() => clear.mutate(undefined, { onError: (e) => toast.error(e.message) })}>
            Clear goal
          </Button>
        )
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <NumberField label="Target" value={target} unit={w.unit} min={w.toDisplay(25)} max={w.toDisplay(300)} step={0.5} format={{ maximumFractionDigits: 1 }} onValueChange={setTarget} />
        <DatePicker label="By (optional)" value={date} min={addDays(today, 1)} onValueChange={(d) => setDate(d as LocalDate)} />
        <Button variant="primary" onClick={submit} loading={save.isPending} disabled={target == null}>
          {goal ? 'Update' : 'Set goal'}
        </Button>
      </div>
      {impliedRate != null && Number.isFinite(impliedRate) && (
        <p className={`mt-3 text-body-sm ${aggressive ? 'text-warn' : 'text-fg-3'}`}>
          That is {w.fmtDelta(impliedRate)} per week{aggressive ? ' — faster than ~1% of body weight a week, which is hard to sustain alongside building run volume.' : '.'}
        </p>
      )}
    </ChartCard>
  );
}

function History({ series }: { series: { date: LocalDate; weightKg?: number; trendKg: number }[] }) {
  const w = useWeightUnits();
  const log = useLogWeight();
  const rows = series.filter((p) => p.weightKg != null).reverse().slice(0, 60);
  if (!rows.length) return null;
  return (
    <ChartCard title="Readings">
      <ul className="divide-y divide-line-1 rounded-lg bg-surface-1">
        {rows.map((p) => (
          <li key={p.date} className="flex items-center justify-between gap-4 px-4 py-2 text-body-sm">
            <span className="text-fg-2">{formatDateMedium(p.date, true)}</span>
            <span className="ml-auto font-mono text-fg-1">{w.fmt(p.weightKg!)}</span>
            <span className="w-28 text-right text-fg-3">trend {formatNumber(w.toDisplay(p.trendKg), 1)}</span>
            <IconButton
              label={`Delete reading for ${formatDateMedium(p.date)}`}
              size="sm"
              variant="ghost"
              icon={<Trash2 />}
              onClick={() => log.mutate({ date: p.date, weightKg: null }, { onSuccess: () => toast.success('Reading removed'), onError: (e) => toast.error(e.message) })}
            />
          </li>
        ))}
      </ul>
    </ChartCard>
  );
}
