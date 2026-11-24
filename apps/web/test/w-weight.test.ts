import { describe, expect, it } from 'vitest';
import { addDays } from '@cadence/core/time';
import { api, json } from './helpers';

describe('weight', () => {
  it('logs readings, returns a trend and rate, and syncs the weight threshold', async () => {
    const empty = await json('/weight');
    expect(empty).toMatchObject({ entries: 0, series: [] });
    const today: string = empty.today;
    const twoWeeksAgo = addDays(today, -14);

    expect(await json(`/weight/${twoWeeksAgo}`, { method: 'PUT', body: { weightKg: 86 } })).toMatchObject({ weightKg: 86, thresholdUpdated: true });
    expect(await json(`/weight/${today}`, { method: 'PUT', body: { weightKg: 84 } })).toMatchObject({ weightKg: 84, thresholdUpdated: true });
    // within 0.5 kg of the current threshold → no new threshold
    expect(await json(`/weight/${today}`, { method: 'PUT', body: { weightKg: 84.2 } })).toMatchObject({ thresholdUpdated: false });
    // an older reading never moves the threshold
    expect(await json(`/weight/${addDays(today, -7)}`, { method: 'PUT', body: { weightKg: 85 } })).toMatchObject({ thresholdUpdated: false });

    const s = await json('/weight');
    expect(s.latest).toEqual({ date: today, weightKg: 84.2 });
    expect(s.entries).toBe(3);
    expect(s.series.at(-1).date).toBe(today);
    expect(s.ratePerWeekKg).toBeLessThan(-0.5);
    // the Day page check-in sees the same value
    const w = await json<any[]>(`/trends/wellness?from=${today}&to=${today}`);
    expect((w as any).days[0].weightKg).toBe(84.2);

    const weights = (await json<any[]>('/thresholds')).filter((t) => t.kind === 'weight');
    expect(weights.map((t) => t.value).sort()).toEqual([84, 86]);
  });

  it('sets, reports and clears a goal', async () => {
    const today: string = (await json('/weight')).today;
    const s = await json('/weight/goal', { method: 'PUT', body: { targetKg: 78, targetDate: addDays(today, 120) } });
    expect(s.goal).toMatchObject({ targetKg: 78, startDate: today });
    expect(s.goal.startKg).toBeGreaterThan(84);
    expect(['on_track', 'behind']).toContain(s.goal.status);
    expect((await json('/settings')).weightGoal).toMatchObject({ targetKg: 78 });

    const cleared = await json('/weight/goal', { method: 'DELETE' });
    expect(cleared.goal).toBeUndefined();
    expect((await json('/settings')).weightGoal).toBeUndefined();
  });

  it('rejects future dates and clears a day with null', async () => {
    const today: string = (await json('/weight')).today;
    expect((await api(`/weight/${addDays(today, 1)}`, { method: 'PUT', body: { weightKg: 80 } })).status).toBe(400);
    expect((await api('/weight/goal', { method: 'PUT', body: { targetKg: 78, targetDate: today } })).status).toBe(400);
    await json(`/weight/${today}`, { method: 'PUT', body: { weightKg: null } });
    expect((await json('/weight')).latest.date).not.toBe(today);
  });
});
