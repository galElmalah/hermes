import { describe, expect, it } from 'vitest';
import { weightGoalProgress, weightSeries, weightSummary } from '../../src/metrics/weight';

describe('weightSeries', () => {
  it('interpolates gaps, carries forward after the last reading and smooths', () => {
    const s = weightSeries([{ date: '2026-11-10', weightKg: 86 }, { date: '2026-11-24', weightKg: 84 }], '2026-11-26');
    expect(s).toHaveLength(17);
    expect(s[0]).toMatchObject({ date: '2026-11-10', weightKg: 86, trendKg: 86 });
    expect(s[7].interpolatedKg).toBeCloseTo(85, 5);
    expect(s[7].weightKg).toBeUndefined();
    expect(s[14]).toMatchObject({ date: '2026-11-24', weightKg: 84 });
    expect(s[16].interpolatedKg).toBe(84);
    // EMA lags the readings but sits between them
    expect(s[14].trendKg).toBeGreaterThan(84);
    expect(s[14].trendKg).toBeLessThan(85);
  });

  it('is empty without readings', () => {
    expect(weightSeries([], '2026-11-24')).toEqual([]);
  });
});

describe('weightSummary', () => {
  it('reports latest, trend, rate and clips the series to the range', () => {
    const s = weightSummary([{ date: '2026-11-10', weightKg: 86 }, { date: '2026-11-24', weightKg: 84 }], { from: '2026-11-20', to: '2026-11-24', today: '2026-11-24' });
    expect(s.latest).toEqual({ date: '2026-11-24', weightKg: 84 });
    expect(s.series.map((p) => p.date)).toEqual(['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']);
    expect(s.entries).toBe(1);
    expect(s.ratePerWeekKg).toBeCloseTo(-1, 1);
    expect(s.change7dKg).toBeLessThan(0);
    expect(s.change28dKg).toBeUndefined();
  });

  it('never extends past today', () => {
    const s = weightSummary([{ date: '2026-11-20', weightKg: 80 }], { from: '2026-11-20', to: '2026-12-31', today: '2026-11-24' });
    expect(s.series.at(-1)?.date).toBe('2026-11-24');
    expect(s.ratePerWeekKg).toBeUndefined(); // fewer than 7 days
  });
});

describe('weightGoalProgress', () => {
  const goal = { targetKg: 78, startKg: 86, startDate: '2026-11-10', targetDate: '2027-03-01' };
  it('projects arrival and flags on-track', () => {
    const p = weightGoalProgress(goal, 84, -0.5, '2026-11-24');
    expect(p.status).toBe('on_track');
    expect(p.remainingKg).toBe(6);
    expect(p.progressPct).toBe(25);
    expect(p.projectedDate).toBe('2027-02-16'); // 12 weeks
    expect(p.requiredRatePerWeekKg).toBeLessThan(0);
  });
  it('behind when the rate is too slow for the date', () => {
    expect(weightGoalProgress(goal, 84, -0.2, '2026-11-24').status).toBe('behind');
  });
  it('wrong direction and reached', () => {
    expect(weightGoalProgress(goal, 84, 0.3, '2026-11-24').status).toBe('wrong_direction');
    expect(weightGoalProgress(goal, 77.9, -0.3, '2026-11-24')).toMatchObject({ status: 'reached', progressPct: 100 });
  });
  it('works for a gain goal', () => {
    expect(weightGoalProgress({ targetKg: 70, startKg: 65, startDate: '2026-11-01' }, 66, 0.25, '2026-11-24').status).toBe('on_track');
  });
});
