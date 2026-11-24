/**
 * Body weight: daily log (stored on wellness_days.weight_kg, shared with the Day page check-in and
 * Garmin scale sync), smoothed trend + rate (core weightSummary) and an optional goal kept in settings.
 *
 *   GET    /weight?from&to        → WeightSummary (default: last 90 days)
 *   PUT    /weight/goal           → set goal { targetKg, targetDate?, startKg?, startDate? }
 *   DELETE /weight/goal           → clear goal
 *   PUT    /weight/:date          → log { weightKg } (null clears that day)
 *
 * Logging the newest reading also keeps the dated `weight` threshold (used for W/kg) in step when it
 * moves by ≥ 0.5 kg, so thresholds don't churn with daily scale noise.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { LocalDate, WeightGoal, type WeightSummary } from '@cadence/core/domain';
import { weightSummary, type WeightEntry } from '@cadence/core/metrics';
import { addDays } from '@cadence/core/time';
import type { AppEnv } from '../env';
import { badRequest } from '../lib/http';
import { listWellness, putWellnessManual } from '../db/furniture';
import { clearSettings, getSettings, updateSettings } from '../db/settings';
import { insertThreshold, listThresholds } from '../db/thresholds';
import { getToday, validate } from '../services/context';
import { afterThresholdChange } from './settings';

/** Readings before `from` used to warm up the trend and the 28-day rate. */
const WARMUP_DAYS = 56;
const THRESHOLD_TOLERANCE_KG = 0.5;

const Range = z.object({ from: LocalDate.optional(), to: LocalDate.optional() });
const LogInput = z.object({ weightKg: z.number().min(25).max(300).nullable() });
const GoalInput = z.object({
  targetKg: WeightGoal.shape.targetKg,
  targetDate: LocalDate.optional(),
  startKg: WeightGoal.shape.startKg.optional(),
  startDate: LocalDate.optional(),
});

async function entriesBetween(env: Env, from: LocalDate, to: LocalDate): Promise<WeightEntry[]> {
  const days = await listWellness(env.DB, { from, to });
  return days.filter((d) => typeof d.weightKg === 'number' && d.weightKg > 0).map((d) => ({ date: d.date, weightKg: d.weightKg! }));
}

/** The WeightSummary for [from, to] (shared with Today and the MCP context). */
export async function getWeightSummary(env: Env, q: { from?: LocalDate; to?: LocalDate } = {}): Promise<WeightSummary> {
  const [today, settings] = await Promise.all([getToday(env), getSettings(env.DB)]);
  const to = q.to ?? today;
  const from = q.from ?? addDays(to, -89);
  if (from > to) throw badRequest('from must be on or before to', 'validation');
  const entries = await entriesBetween(env, addDays(from, -WARMUP_DAYS), to);
  return weightSummary(entries, { from, to, today, goal: settings.weightGoal });
}

/** Keep the dated weight threshold in step with the newest logged reading. */
async function syncThreshold(env: Env, date: LocalDate, weightKg: number): Promise<boolean> {
  const today = await getToday(env);
  const newer = await entriesBetween(env, addDays(date, 1), today);
  if (newer.length) return false;
  const weights = (await listThresholds(env.DB)).filter((t) => t.kind === 'weight' && t.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const current = weights[0];
  if (current && Math.abs(current.value - weightKg) < THRESHOLD_TOLERANCE_KG) return false;
  await insertThreshold(env.DB, { kind: 'weight', sport: 'all', value: Math.round(weightKg * 10) / 10, effectiveFrom: date, source: 'manual', note: 'From weight log' });
  return true;
}

/** Mounted at /api. */
export const weightRoutes = new Hono<AppEnv>()
  .get('/weight', validate('query', Range), async (c) => c.json(await getWeightSummary(c.env, c.req.valid('query'))))
  .put('/weight/goal', validate('json', GoalInput), async (c) => {
    const input = c.req.valid('json');
    const today = await getToday(c.env);
    if (input.targetDate && input.targetDate <= today) throw badRequest('targetDate must be in the future', 'validation');
    let startKg = input.startKg;
    if (startKg === undefined) {
      const s = await getWeightSummary(c.env, { from: addDays(today, -27), to: today });
      startKg = s.trendKg ?? s.latest?.weightKg;
    }
    if (startKg === undefined) throw badRequest('Log a weight first, or pass startKg', 'validation');
    const goal = WeightGoal.parse({ targetKg: input.targetKg, targetDate: input.targetDate, startKg, startDate: input.startDate ?? today });
    await updateSettings(c.env.DB, { weightGoal: goal });
    return c.json(await getWeightSummary(c.env));
  })
  .delete('/weight/goal', async (c) => {
    await clearSettings(c.env.DB, ['weightGoal']);
    return c.json(await getWeightSummary(c.env));
  })
  .put('/weight/:date', validate('param', z.object({ date: LocalDate })), validate('json', LogInput), async (c) => {
    const { date } = c.req.valid('param');
    const { weightKg } = c.req.valid('json');
    const today = await getToday(c.env);
    if (date > today) throw badRequest("Can't log weight for a future date", 'validation');
    await putWellnessManual(c.env.DB, date, { weightKg });
    let thresholdUpdated = false;
    if (weightKg !== null) {
      thresholdUpdated = await syncThreshold(c.env, date, weightKg);
      if (thresholdUpdated) c.executionCtx.waitUntil(afterThresholdChange(c.env, date, undefined));
    }
    return c.json({ date, weightKg, thresholdUpdated });
  });
