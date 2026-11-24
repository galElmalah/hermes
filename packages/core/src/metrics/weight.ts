/**
 * Body-weight trend. Daily scale readings swing ±1 kg with water and food, so everything here works on
 * a smoothed trend rather than raw readings:
 *
 *  1. Gaps between logged days are filled by linear interpolation (no extrapolation past the last
 *     reading — the value is carried forward), so sparse logging still yields a daily series.
 *  2. The trend is an exponential moving average of that series (α = 0.25, roughly a 7-day window).
 *  3. The rate is the least-squares slope of the interpolated series over the last 28 days, in kg/week.
 *     Using the interpolated values (not the EMA) avoids the EMA's lag in the slope.
 */
import type { LocalDate, WeightGoal, WeightGoalProgress, WeightPoint, WeightSummary } from '../domain';
import { addDays, diffDays } from '../time';

export const WEIGHT_TREND_ALPHA = 0.25;
export const WEIGHT_RATE_WINDOW_DAYS = 28;

export interface WeightEntry {
  date: LocalDate;
  weightKg: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Daily interpolated values from the first entry to `to` (carried forward after the last entry). */
function dailyValues(entries: WeightEntry[], to: LocalDate): { date: LocalDate; value: number; logged?: number }[] {
  const sorted = entries.filter((e) => e.weightKg > 0 && e.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return [];
  const out: { date: LocalDate; value: number; logged?: number }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    out.push({ date: cur.date, value: cur.weightKg, logged: cur.weightKg });
    const end = next ? next.date : to;
    const span = diffDays(cur.date, end);
    for (let k = 1; k < span; k++) {
      const value = next ? cur.weightKg + ((next.weightKg - cur.weightKg) * k) / span : cur.weightKg;
      out.push({ date: addDays(cur.date, k), value });
    }
    if (!next && span > 0) out.push({ date: end, value: cur.weightKg });
  }
  return out;
}

/** Least-squares slope (per day) of y over x = 0..n-1. */
function slope(ys: number[]): number | undefined {
  const n = ys.length;
  if (n < 2) return undefined;
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (ys[i] - my);
    den += (i - mx) ** 2;
  }
  return den ? num / den : undefined;
}

/** Smoothed daily series from the first entry through `to`. */
export function weightSeries(entries: WeightEntry[], to: LocalDate, alpha = WEIGHT_TREND_ALPHA): (WeightPoint & { interpolatedKg: number })[] {
  const days = dailyValues(entries, to);
  let trend: number | undefined;
  return days.map((d) => {
    trend = trend === undefined ? d.value : trend + alpha * (d.value - trend);
    return { date: d.date, ...(d.logged !== undefined ? { weightKg: d.logged } : {}), trendKg: r2(trend), interpolatedKg: d.value };
  });
}

export function weightGoalProgress(goal: WeightGoal, trendKg: number | undefined, ratePerWeekKg: number | undefined, today: LocalDate): WeightGoalProgress {
  if (trendKg === undefined) return { ...goal, remainingKg: r2(goal.startKg - goal.targetKg), progressPct: 0, status: 'no_data' };
  const losing = goal.targetKg < goal.startKg;
  const dir = losing ? -1 : 1; // sign of the change we want
  const remainingKg = r2(trendKg - goal.targetKg);
  const total = goal.startKg - goal.targetKg;
  const progressPct = total === 0 ? 100 : Math.max(0, Math.min(100, Math.round(((goal.startKg - trendKg) / total) * 100)));
  const reached = losing ? trendKg <= goal.targetKg : trendKg >= goal.targetKg;
  const weeksLeft = goal.targetDate ? diffDays(today, goal.targetDate) / 7 : undefined;
  const requiredRatePerWeekKg = !reached && weeksLeft !== undefined && weeksLeft > 0 ? r2((goal.targetKg - trendKg) / weeksLeft) : undefined;
  if (reached) return { ...goal, remainingKg, progressPct: 100, status: 'reached' };
  const movingRight = ratePerWeekKg !== undefined && ratePerWeekKg * dir > 0.02;
  if (!movingRight) return { ...goal, remainingKg, progressPct, ...(requiredRatePerWeekKg !== undefined ? { requiredRatePerWeekKg } : {}), status: ratePerWeekKg === undefined ? 'no_data' : 'wrong_direction' };
  const daysToGo = Math.ceil((Math.abs(remainingKg) / Math.abs(ratePerWeekKg!)) * 7);
  const projectedDate = daysToGo <= 3650 ? addDays(today, daysToGo) : undefined;
  const onTrack = !goal.targetDate || (projectedDate !== undefined && projectedDate <= goal.targetDate);
  return {
    ...goal,
    remainingKg,
    progressPct,
    ...(requiredRatePerWeekKg !== undefined ? { requiredRatePerWeekKg } : {}),
    ...(projectedDate ? { projectedDate } : {}),
    status: onTrack ? 'on_track' : 'behind',
  };
}

/**
 * Everything the app shows about weight for a range. `entries` should include readings from before
 * `from` (ideally ≥ 28 days) so the trend and rate are warmed up; the returned series is clipped to [from, to].
 */
export function weightSummary(entries: WeightEntry[], opts: { from: LocalDate; to: LocalDate; today: LocalDate; goal?: WeightGoal }): WeightSummary {
  const { from, to, today, goal } = opts;
  const end = to < today ? to : today; // never project the series into the future
  const full = weightSeries(entries, end);
  const at = (d: LocalDate) => full.find((p) => p.date === d);
  const last = full.at(-1);
  const trendKg = last?.trendKg;
  const back = (n: number) => {
    if (!last) return undefined;
    const p = at(addDays(last.date, -n));
    return p ? r2(last.trendKg - p.trendKg) : undefined;
  };
  const window = full.slice(-WEIGHT_RATE_WINDOW_DAYS).map((p) => p.interpolatedKg);
  const perDay = window.length >= 7 ? slope(window) : undefined;
  const ratePerWeekKg = perDay === undefined ? undefined : r2(perDay * 7);
  const logged = [...entries].filter((e) => e.weightKg > 0 && e.date <= end).sort((a, b) => a.date.localeCompare(b.date));
  const latest = logged.at(-1);
  const series = full.filter((p) => p.date >= from && p.date <= to).map(({ interpolatedKg: _i, ...p }) => p);
  const out: WeightSummary = {
    today,
    from,
    to,
    entries: logged.filter((e) => e.date >= from && e.date <= to).length,
    series,
  };
  if (latest) out.latest = { date: latest.date, weightKg: latest.weightKg };
  if (trendKg !== undefined) out.trendKg = trendKg;
  const c7 = back(7);
  const c28 = back(28);
  if (c7 !== undefined) out.change7dKg = c7;
  if (c28 !== undefined) out.change28dKg = c28;
  if (ratePerWeekKg !== undefined) out.ratePerWeekKg = ratePerWeekKg;
  if (goal) out.goal = weightGoalProgress(goal, trendKg, ratePerWeekKg, today);
  return out;
}
