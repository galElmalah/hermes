import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { ActivityDetail, ExecutionAnalysis, PlannedWorkoutDetail } from '@cadence/core/domain';
import { json } from './helpers';

vi.setConfig({ testTimeout: 300_000 });

async function seed() {
  let p = await json('/demo/seed', { method: 'POST', body: { months: 1, seed: 4, fast: true, today: '2026-11-21', now: '2026-11-21T19:00:00Z' } });
  for (let i = 0; !p.finished && i < 40; i++) p = await json('/demo/seed/step', { method: 'POST', body: { maxActivities: 40 } });
  expect(p.finished).toBe(true);
}

/** A paired workout with a structure whose activity has streams. */
async function pairedStructured() {
  const row = await env.DB.prepare(
    `SELECT w.id AS wid, a.id AS aid, w.date AS date FROM workouts w JOIN activities a ON a.id = w.paired_activity_id
     WHERE w.structure IS NOT NULL AND a.has_streams = 1 ORDER BY w.date DESC LIMIT 1`,
  ).first<{ wid: string; aid: string; date: string }>();
  expect(row).not.toBeNull();
  return row!;
}

describe('workout execution (plan vs actual)', () => {
  it('is embedded in the activity and workout detail, and drives the calendar state', async () => {
    await seed();
    const { wid, aid, date } = await pairedStructured();

    const w = PlannedWorkoutDetail.parse(await json(`/workouts/${wid}`));
    expect(w.execution).toBeDefined();
    const x = ExecutionAnalysis.parse(w.execution);
    expect(x.workoutId).toBe(wid);
    expect(x.activityId).toBe(aid);
    expect(x.score).toBeGreaterThanOrEqual(0);
    expect(x.score).toBeLessThanOrEqual(100);
    expect(x.summary.length).toBeGreaterThan(0);
    if (x.method !== 'session') {
      expect(x.steps.length).toBeGreaterThan(0);
      expect(w.compliance).toMatchObject({ state: x.state, score: x.score });
    }

    const a = ActivityDetail.parse(await json(`/activities/${aid}`));
    expect(a.execution?.score).toBe(x.score);
    expect(a.compliance?.state).toBe(x.state);

    // Cached for list views: the calendar shows the same state (and score) for that workout.
    const row = await env.DB.prepare('SELECT score, state, method FROM workout_execution WHERE workout_id = ?').bind(wid).first<{ score: number; state: string; method: string }>();
    expect(row).toMatchObject({ score: x.score, state: x.state, method: x.method });
    const cal = await json(`/calendar?from=${date}&to=${date}`);
    const chip = cal.workouts.find((c: { id: string }) => c.id === wid);
    if (x.method !== 'session') expect(chip.compliance).toMatchObject({ state: x.state, score: x.score });
  });

  it('follows the plan: editing the structure invalidates and refreshes the cached state', async () => {
    const { wid } = await pairedStructured();
    const before = await env.DB.prepare('SELECT fingerprint FROM workout_execution WHERE workout_id = ?').bind(wid).first<{ fingerprint: string }>();
    const w = await json(`/workouts/${wid}`);
    // Replace the plan with one 20-minute step at an impossible power: the analysis must change.
    const res = await json(`/workouts/${wid}`, {
      method: 'PATCH',
      body: { structure: { steps: [{ kind: 'step', id: 's1', role: 'active', measure: { type: 'time', sec: 1200 }, target: { type: 'hr_bpm', low: 195, high: 200 } }] } },
    });
    expect(res.id).toBe(wid);
    const after = await env.DB.prepare('SELECT fingerprint FROM workout_execution WHERE workout_id = ?').bind(wid).first<{ fingerprint: string }>();
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
    const x = ExecutionAnalysis.parse((await json(`/workouts/${wid}`)).execution);
    expect(x.score).toBeLessThan(w.execution.score + 1);
    expect(x.counts.planned).toBe(1);
  });

  it('is absent when unpaired', async () => {
    const { wid } = await pairedStructured();
    await json(`/workouts/${wid}/pair`, { method: 'DELETE' });
    const w = await json(`/workouts/${wid}`);
    expect(w.execution).toBeUndefined();
    expect(w.compliance.score).toBeUndefined();
  });
});
