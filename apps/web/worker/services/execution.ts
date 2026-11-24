/**
 * Workout execution (plan vs actual) on the Worker: loads what core `analyzeExecution` needs
 * (structure, laps, streams, thresholds on the workout date, unit preference), and keeps a tiny
 * per-workout cache (`workout_execution`: score + state + fingerprint) so list views — calendar
 * chips, week, today — can show the state derived from the step-by-step score without decoding
 * streams. The detail endpoints always compute fresh; the cache is only trusted while its
 * fingerprint (analysis version, workout/activity ids + updatedAt, thresholds) still matches, so a
 * pairing, plan or threshold change can never show a stale state (it falls back to the totals
 * ratio until the row is refreshed by a detail read, a pairing/plan hook or the cron).
 */
import type { Activity, ComplianceState, ExecutionAnalysis, Lap, LocalDate, PlannedWorkout, Sport, ThresholdSnapshot } from '@cadence/core/domain';
import { EXECUTION_VERSION, analyzeExecution, computeCompliance } from '@cadence/core/workout';
import { addDays } from '@cadence/core/time';
import { getActivityFull, listActivities } from '../db/activities';
import { getSettings } from '../db/settings';
import { chunk, placeholders } from '../db/sql';
import { getStreams } from '../db/streams';
import { thresholdResolver } from '../db/thresholds';
import { listWorkouts } from '../db/workouts';
import { getToday } from './context';

export interface ExecutionCacheRow {
  workoutId: string;
  activityId: string;
  fingerprint: string;
  method: ExecutionAnalysis['method'];
  score: number;
  state: ComplianceState;
}

export type ThresholdsFor = (date: LocalDate, sport: Sport) => ThresholdSnapshot;

/** Lookups for list decoration: cached rows + the thresholds resolver (to validate fingerprints). */
export interface ExecutionLookup {
  cache: Map<string, ExecutionCacheRow>;
  thresholds: ThresholdsFor;
}

/** FNV-1a 32-bit, hex. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Stable JSON (sorted keys) of a thresholds snapshot. */
function stableTh(th: ThresholdSnapshot): string {
  return JSON.stringify(Object.keys(th).sort().map((k) => [k, th[k as keyof ThresholdSnapshot]]));
}

export function executionFingerprint(w: Pick<PlannedWorkout, 'id' | 'updatedAt'>, a: Pick<Activity, 'id' | 'updatedAt'>, th: ThresholdSnapshot): string {
  return `${EXECUTION_VERSION}:${fnv(`${w.id}|${w.updatedAt}|${a.id}|${a.updatedAt}|${stableTh(th)}`)}`;
}

/** The cached row when it is still valid for this pair, else undefined. */
export function validExecution(lookup: ExecutionLookup | undefined, w: PlannedWorkout, a: Activity | undefined): ExecutionCacheRow | undefined {
  if (!lookup || !a) return undefined;
  const row = lookup.cache.get(w.id);
  if (!row || row.activityId !== a.id) return undefined;
  return row.fingerprint === executionFingerprint(w, a, lookup.thresholds(w.date, w.sport)) ? row : undefined;
}

interface Row {
  workout_id: string;
  activity_id: string;
  fingerprint: string;
  method: string;
  score: number;
  state: string;
}

const toRow = (r: Row): ExecutionCacheRow => ({
  workoutId: r.workout_id,
  activityId: r.activity_id,
  fingerprint: r.fingerprint,
  method: r.method as ExecutionCacheRow['method'],
  score: r.score,
  state: r.state as ComplianceState,
});

/** Cached rows for workouts dated in [from, to] (one statement; batches with the window loads). */
export async function listExecutionCacheInRange(db: D1Database, from: LocalDate, to: LocalDate): Promise<ExecutionCacheRow[]> {
  const { results } = await db
    .prepare('SELECT e.* FROM workout_execution e JOIN workouts w ON w.id = e.workout_id WHERE w.date >= ? AND w.date <= ?')
    .bind(from, to)
    .all<Row>();
  return results.map(toRow);
}

export async function listExecutionCache(db: D1Database, workoutIds: string[]): Promise<ExecutionCacheRow[]> {
  const out: ExecutionCacheRow[] = [];
  for (const part of chunk([...new Set(workoutIds)], 90)) {
    const { results } = await db.prepare(`SELECT * FROM workout_execution WHERE workout_id IN (${placeholders(part.length)})`).bind(...part).all<Row>();
    out.push(...results.map(toRow));
  }
  return out;
}

export async function executionLookup(db: D1Database, workoutIds: string[]): Promise<ExecutionLookup> {
  const [rows, thresholds] = await Promise.all([listExecutionCache(db, workoutIds), thresholdResolver(db)]);
  return { cache: new Map(rows.map((r) => [r.workoutId, r])), thresholds };
}

async function storeExecution(db: D1Database, x: ExecutionAnalysis, fingerprint: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO workout_execution (workout_id, activity_id, fingerprint, method, score, state, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workout_id) DO UPDATE SET activity_id = excluded.activity_id, fingerprint = excluded.fingerprint, method = excluded.method,
         score = excluded.score, state = excluded.state, computed_at = excluded.computed_at`,
    )
    .bind(x.workoutId, x.activityId, fingerprint, x.method, x.score, x.state, new Date().toISOString())
    .run();
}

/**
 * The full analysis for a paired workout + activity (fresh), stored in the cache when its
 * fingerprint changed. `activity` may be passed when already loaded (laps come from `laps`).
 */
export async function computeExecution(
  env: Env,
  workout: PlannedWorkout,
  opts: { activityId?: string; preloaded?: { activity: Activity; laps: Lap[] }; thresholds?: ThresholdsFor; today?: LocalDate; units?: 'metric' | 'imperial'; cached?: ExecutionCacheRow | null } = {},
): Promise<ExecutionAnalysis | undefined> {
  const db = env.DB;
  const activityId = opts.activityId ?? workout.pairedActivityId;
  if (!activityId) return undefined;
  let activity: Activity;
  let laps: Lap[];
  if (opts.preloaded && opts.preloaded.activity.id === activityId) ({ activity, laps } = opts.preloaded);
  else {
    const full = await getActivityFull(db, activityId);
    if (!full) return undefined;
    activity = full.activity;
    laps = full.extras.laps;
  }
  const [streams, resolve, today, units] = await Promise.all([
    activity.hasStreams ? getStreams(db, activity.id) : Promise.resolve(null),
    opts.thresholds ? Promise.resolve(opts.thresholds) : thresholdResolver(db),
    opts.today ? Promise.resolve(opts.today) : getToday(env),
    opts.units ? Promise.resolve(opts.units) : getSettings(db).then((s) => s.units),
  ]);
  const thresholds = resolve(workout.date, workout.sport);
  const analysis = analyzeExecution({
    workout,
    activity,
    laps,
    streams,
    thresholds,
    units,
    compliance: computeCompliance(workout, activity, { today }),
  });
  const fp = executionFingerprint(workout, activity, thresholds);
  try {
    const cached = opts.cached !== undefined ? opts.cached : (await listExecutionCache(db, [workout.id]))[0];
    if (!cached || cached.fingerprint !== fp || cached.score !== analysis.score || cached.state !== analysis.state) await storeExecution(db, analysis, fp);
  } catch (e) {
    console.error('storing execution failed', workout.id, e);
  }
  return analysis;
}

/**
 * Recompute and store the cached state for these workouts when it is missing or stale (paired
 * ones only). Never throws: callers are write paths whose own change is already committed.
 */
export async function refreshExecutions(env: Env, workoutIds: Iterable<string>, opts: { limit?: number } = {}): Promise<number> {
  const ids = [...new Set(workoutIds)];
  if (!ids.length) return 0;
  try {
    const workouts = (await listWorkouts(env.DB, { ids })).filter((w) => w.pairedActivityId);
    if (!workouts.length) return 0;
    const [activities, lookup, today, settings] = await Promise.all([
      listActivities(env.DB, { ids: workouts.map((w) => w.pairedActivityId!) }),
      executionLookup(env.DB, workouts.map((w) => w.id)),
      getToday(env),
      getSettings(env.DB),
    ]);
    const byId = new Map(activities.map((a) => [a.id, a]));
    const stale = workouts.filter((w) => {
      const a = byId.get(w.pairedActivityId!);
      return a && !validExecution(lookup, w, a);
    });
    stale.sort((a, b) => b.date.localeCompare(a.date));
    let n = 0;
    for (const w of stale.slice(0, opts.limit ?? 25)) {
      try {
        await computeExecution(env, w, { thresholds: lookup.thresholds, today, units: settings.units, cached: lookup.cache.get(w.id) ?? null });
        n++;
      } catch (e) {
        console.error('execution refresh failed', w.id, e);
      }
    }
    return n;
  } catch (e) {
    console.error('execution refresh failed', e);
    return 0;
  }
}

/** Paired workouts on these dates (after a re-pairing). */
export async function refreshExecutionsOn(env: Env, dates: LocalDate[]): Promise<number> {
  const uniq = [...new Set(dates)];
  if (!uniq.length) return 0;
  try {
    const ids: string[] = [];
    for (const part of chunk(uniq, 90)) {
      const { results } = await env.DB.prepare(`SELECT id FROM workouts WHERE paired_activity_id IS NOT NULL AND date IN (${placeholders(part.length)})`)
        .bind(...part)
        .all<{ id: string }>();
      ids.push(...results.map((r) => r.id));
    }
    return await refreshExecutions(env, ids);
  } catch (e) {
    console.error('execution refresh failed', e);
    return 0;
  }
}

/** Cron / after a threshold change: refresh stale rows of paired workouts since `from` (newest first). */
export async function refreshStaleExecutions(env: Env, opts: { from?: LocalDate; limit?: number } = {}): Promise<number> {
  try {
    const from = opts.from ?? addDays(await getToday(env), -365);
    const { results } = await env.DB.prepare(
      `SELECT w.id FROM workouts w LEFT JOIN workout_execution e ON e.workout_id = w.id
       WHERE w.paired_activity_id IS NOT NULL AND w.date >= ? ORDER BY w.date DESC LIMIT 400`,
    )
      .bind(from)
      .all<{ id: string }>();
    return await refreshExecutions(env, results.map((r) => r.id), { limit: opts.limit ?? 40 });
  } catch (e) {
    console.error('stale execution refresh failed', e);
    return 0;
  }
}
