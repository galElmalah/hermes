import { describe, expect, it } from 'vitest';
import type { ActivityStreams, Lap, PlannedWorkout, WorkoutStructure } from '../../src/domain';
import {
  analyzeExecution,
  complianceWithExecution,
  computeCompliance,
  makeRepeat,
  makeStep,
  resolveExecutionTarget,
  type ExecutionInput,
} from '../../src/workout';
import { activity, planned } from './fixtures';

// ───────────── synthetic recordings ─────────────

/** Deterministic noise in [-1, 1]. */
function noise(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  };
}

interface Block {
  sec: number;
  speed?: number; // m/s
  power?: number; // W
  hr?: number; // bpm
  /** Seconds of pause (timer stopped) before this block: a gap in t. */
  pauseBefore?: number;
}

function record(blocks: Block[], opts: { seed?: number; noisePct?: number; hrLag?: boolean } = {}): ActivityStreams {
  const rnd = noise(opts.seed ?? 7);
  const pct = opts.noisePct ?? 0.015;
  const t: number[] = [];
  const speed: (number | null)[] = [];
  const power: (number | null)[] = [];
  const hr: (number | null)[] = [];
  const distance: (number | null)[] = [];
  let clock = 0;
  let d = 0;
  let h = blocks[0]?.hr ?? 100;
  for (const b of blocks) {
    clock += b.pauseBefore ?? 0;
    for (let i = 0; i < b.sec; i++) {
      t.push(clock++);
      const v = b.speed !== undefined ? Math.max(0, b.speed * (1 + pct * rnd())) : null;
      speed.push(v);
      d += v ?? 0;
      distance.push(d);
      power.push(b.power !== undefined ? Math.max(0, Math.round(b.power * (1 + 2 * pct * rnd()))) : null);
      if (b.hr !== undefined) {
        h = opts.hrLag ? h + (b.hr - h) * 0.05 : b.hr;
        hr.push(Math.round(h + 2 * rnd()));
      } else hr.push(null);
    }
  }
  const out: ActivityStreams = { t, distance, hr };
  if (speed.some((v) => v !== null)) out.speed = speed;
  if (power.some((v) => v !== null)) out.power = power;
  return out;
}

/** One lap per block (as a watch-guided workout records them). */
function lapsOf(blocks: Block[]): Lap[] {
  const laps: Lap[] = [];
  let clock = 0;
  blocks.forEach((b, index) => {
    clock += b.pauseBefore ?? 0;
    laps.push({ index, startSec: clock, durationSec: b.sec, movingSec: b.sec, distanceM: (b.speed ?? 0) * b.sec, avgSpeedMps: b.speed, avgHr: b.hr, avgPower: b.power });
    clock += b.sec;
  });
  return laps;
}

// ───────────── the plan: 10′ @ 6:00/km, 5 × (4′ @ 5:00/km + 3′ @ 70–78 % pace), 10′ @ 70–78 % ─────────────

const TH = { runThresholdMps: 2.66, lthr: 181, hrMax: 203, hrRest: 43, ftp: 250 };
const WU = 1000 / 360; // 6:00/km
const REP = 1000 / 300; // 5:00/km
const EASY = 2.66 * 0.74; // middle of 70–78 % of threshold
const WALK = 1.3;

function intervalPlan(): WorkoutStructure {
  return {
    steps: [
      makeStep({ id: 'wu', role: 'warmup', measure: { type: 'time', sec: 600 }, target: { type: 'pace', lowMps: WU, highMps: WU } }),
      makeRepeat(5, [
        makeStep({ id: 'rep', role: 'active', measure: { type: 'time', sec: 240 }, target: { type: 'pace', lowMps: REP, highMps: REP } }),
        makeStep({ id: 'rec', role: 'recovery', measure: { type: 'time', sec: 180 }, target: { type: 'pace_pct', low: 70, high: 78 } }),
      ]),
      makeStep({ id: 'cd', role: 'cooldown', measure: { type: 'time', sec: 600 }, target: { type: 'pace_pct', low: 70, high: 78 } }),
    ],
  };
}

function blocksFor(o: { rep?: number | ((k: number) => number); repSec?: number; skipRep?: number; stopAfterRep?: number; preWalk?: number; wuSec?: number; leadIdle?: number } = {}): Block[] {
  const rep = (k: number) => (typeof o.rep === 'function' ? o.rep(k) : (o.rep ?? REP));
  const b: Block[] = [];
  if (o.leadIdle) b.push({ sec: o.leadIdle, speed: 0, hr: 90 });
  if (o.preWalk) b.push({ sec: o.preWalk, speed: WALK, hr: 100 });
  b.push({ sec: o.wuSec ?? 600, speed: WU, hr: 130 });
  for (let k = 1; k <= 5; k++) {
    if (o.skipRep === k) {
      // Jogged straight through: the recovery before continues.
      b[b.length - 1].sec += 240;
    } else b.push({ sec: o.repSec ?? 240, speed: rep(k), hr: 165 });
    if (o.stopAfterRep !== undefined && k === o.stopAfterRep) return b;
    b.push({ sec: 180, speed: EASY, hr: 135 });
  }
  b.push({ sec: 600, speed: EASY, hr: 130 });
  return b;
}

function workout(structure: WorkoutStructure | undefined, over: Partial<PlannedWorkout> = {}): PlannedWorkout {
  return planned({ id: 'wk', date: '2026-11-23', sport: 'run', structure, plannedDurationSec: 3300, plannedDistanceM: 8600, plannedLoad: 90, ...over });
}

function run(blocks: Block[] | null, opts: { laps?: Lap[]; structure?: WorkoutStructure | null; seed?: number; streams?: ActivityStreams | null; load?: number } = {}) {
  const w = workout(opts.structure === null ? undefined : (opts.structure ?? intervalPlan()));
  const streams = opts.streams !== undefined ? opts.streams : blocks ? record(blocks, { seed: opts.seed }) : null;
  const sec = blocks ? blocks.reduce((s, b) => s + b.sec, 0) : 3300;
  const dist = blocks ? blocks.reduce((s, b) => s + (b.speed ?? 0) * b.sec, 0) : 8600;
  const a = activity({ id: 'act', localDate: '2026-11-23', durationSec: sec, movingSec: sec, distanceM: dist, load: opts.load ?? 92 });
  const input: ExecutionInput = {
    workout: w,
    activity: a,
    laps: opts.laps ?? [],
    streams,
    thresholds: TH,
    units: 'metric',
    compliance: computeCompliance(w, a, { today: '2026-11-24' }),
  };
  const r = analyzeExecution(input);
  return r;
}

const planned12 = (r: ReturnType<typeof run>) => r.steps.filter((s) => s.plannedIndex !== null);

// ───────────── tests ─────────────

describe('resolveExecutionTarget', () => {
  it('widens a point pace into a band and keeps the planned point', () => {
    const r = resolveExecutionTarget({ type: 'pace', lowMps: REP, highMps: REP }, 'run', TH);
    expect(r.point).toBe(true);
    expect(r.target!.metric).toBe('speed');
    expect(r.target!.plannedLow).toBeCloseTo(REP);
    expect(r.target!.low).toBeLessThan(REP);
    expect(r.target!.high).toBeGreaterThan(REP);
    expect(r.target!.text).toBe('5:00/km');
  });
  it('resolves % threshold pace, HR zones and power from thresholds', () => {
    const p = resolveExecutionTarget({ type: 'pace_pct', low: 70, high: 78 }, 'run', TH).target!;
    expect(p.low).toBeCloseTo(1.862, 3);
    expect(p.text).toBe('70–78% pace · 8:02–8:57/km');
    const h = resolveExecutionTarget({ type: 'hr_zone', zone: 2 }, 'run', TH).target!;
    expect(h.metric).toBe('hr');
    expect(Math.round(h.low)).toBe(147);
    const w = resolveExecutionTarget({ type: 'power_pct', low: 56, high: 75 }, 'bike', TH).target!;
    expect([Math.round(w.low), Math.round(w.high)]).toEqual([140, 188]);
    expect(w.text).toBe('Z2 · 140–188 W');
  });
  it('is not measurable for open / RPE targets or a missing threshold', () => {
    expect(resolveExecutionTarget({ type: 'open' }, 'run', TH).target).toBeNull();
    expect(resolveExecutionTarget({ type: 'rpe', low: 6, high: 7 }, 'run', TH)).toMatchObject({ target: null, text: 'RPE 6–7' });
    expect(resolveExecutionTarget({ type: 'pace_pct', low: 90, high: 95 }, 'run', {}).target).toBeNull();
  });
  it('ramps keep their endpoints', () => {
    const r = resolveExecutionTarget({ type: 'ramp', basis: 'power_pct', from: 50, to: 75 }, 'bike', TH);
    expect(r.ramp).toBe(true);
    expect(r.target).toMatchObject({ metric: 'power', from: 125, to: 187.5, low: 125, high: 187.5 });
  });
});

describe('analyzeExecution — streams alignment', () => {
  it('perfect execution: every step on target, high confidence, score ≥ 95', () => {
    const r = run(blocksFor());
    expect(r.method).toBe('streams');
    expect(r.confidence).toBe('high');
    expect(planned12(r)).toHaveLength(12);
    expect(r.counts).toMatchObject({ planned: 12, onTarget: 12, skipped: 0 });
    expect(r.score).toBeGreaterThanOrEqual(95);
    expect(r.state).toBe('on_target');
    expect(r.summary).toBe('Hit all 5 reps');
    const rep3 = r.steps.find((s) => s.label === 'Rep 3 of 5')!;
    expect(rep3.repeat).toEqual({ iteration: 3, count: 5 });
    expect(rep3.actual!.durationSec).toBeGreaterThan(225);
    expect(rep3.actual!.durationSec).toBeLessThan(255);
    expect(rep3.intensity!.verdict).toBe('on');
    expect(rep3.intensity!.inTargetPct).toBeGreaterThan(80);
    expect(rep3.deviation).toBeNull();
    // weights: reps outweigh warm-up / recoveries; all sum to 1
    const sum = r.steps.reduce((s, x) => s + x.weight, 0);
    expect(sum).toBeCloseTo(1, 2);
    expect(rep3.weight).toBeGreaterThan(r.steps.find((s) => s.label === 'Recovery 3 of 5')!.weight);
  });

  it('every rep too fast: reps are "over" with a signed pace deviation, and it costs score', () => {
    const fast = 1000 / 280; // 4:40/km
    const r = run(blocksFor({ rep: fast }));
    const reps = r.steps.filter((s) => s.role === 'active');
    expect(reps).toHaveLength(5);
    for (const s of reps) {
      expect(s.verdict).toBe('over');
      expect(s.intensity!.verdict).toBe('over');
      expect(s.intensity!.deltaPaceSec).toBeGreaterThan(15);
      expect(s.intensity!.deltaPaceSec).toBeLessThan(25);
      expect(s.deviation).toMatch(/^\d+ s\/km faster than target$/);
    }
    expect(r.summary).toMatch(/^Hit 0 of 5 reps; reps ran \d+(–\d+)? s\/km fast$/);
    expect(r.score).toBeLessThan(80);
    expect(r.state).toBe('partial_long');
  });

  it('every rep too slow: "under", partial_short', () => {
    const r = run(blocksFor({ rep: 1000 / 320 })); // 5:20/km
    const reps = r.steps.filter((s) => s.role === 'active');
    expect(reps.every((s) => s.verdict === 'under')).toBe(true);
    expect(reps[0].deviation).toMatch(/s\/km slower than target/);
    expect(r.summary).toMatch(/reps ran .* slow/);
    expect(['partial_short', 'off_short']).toContain(r.state);
  });

  it('one rep skipped (jogged through): that rep is skipped, the rest on target', () => {
    const r = run(blocksFor({ skipRep: 3 }));
    expect(r.method).toBe('streams');
    const rep3 = r.steps.find((s) => s.label === 'Rep 3 of 5')!;
    expect(rep3.verdict).toBe('skipped');
    expect(rep3.actual).toBeNull();
    expect(rep3.score).toBe(0);
    for (const k of [1, 2, 4, 5]) expect(r.steps.find((s) => s.label === `Rep ${k} of 5`)!.verdict).toBe('on_target');
    expect(r.summary.startsWith('Did 4 of 5 reps')).toBe(true);
    expect(r.score).toBeLessThan(90);
    expect(r.score).toBeGreaterThan(60);
  });

  it('cut short after rep 3: the rest is skipped, the session reads short', () => {
    const r = run(blocksFor({ stopAfterRep: 3 }));
    const byLabel = (l: string) => r.steps.find((s) => s.label === l)!;
    expect(byLabel('Rep 3 of 5').verdict).toBe('on_target');
    expect(byLabel('Rep 4 of 5').verdict).toBe('skipped');
    expect(byLabel('Rep 5 of 5').verdict).toBe('skipped');
    expect(byLabel('Cool-down').verdict).toBe('skipped');
    expect(r.summary).toBe('Did 3 of 5 reps; skipped the cool-down');
    expect(['partial_short', 'off_short']).toContain(r.state);
  });

  it('extra warm-up: a walk before a long warm-up is extra (not scored) and the warm-up reads long', () => {
    const r = run(blocksFor({ preWalk: 300, wuSec: 900 }));
    expect(r.steps[0].verdict).toBe('extra');
    expect(r.steps[0].actual!.durationSec).toBeGreaterThan(270);
    expect(r.steps[0].score).toBeNull();
    const wu = r.steps.find((s) => s.role === 'warmup')!;
    expect(wu.duration!.verdict).toBe('long');
    expect(wu.verdict).toBe('over');
    expect(wu.deviation).toMatch(/long$/);
    expect(r.steps.filter((s) => s.role === 'active').every((s) => s.verdict === 'on_target')).toBe(true);
    expect(r.summary).toBe('Hit all 5 reps; warm-up ran long');
    expect(r.score).toBeGreaterThan(85);
  });

  it('late start and a pause mid-rep do not shift the alignment', () => {
    const blocks = blocksFor({ leadIdle: 40 });
    // pause of 45 s in the middle of rep 2: split that block in two with a gap
    const i = blocks.findIndex((b, k) => k > 2 && b.speed === REP); // rep 2 (rep 1 is block 2)
    const rep2 = blocks[i];
    blocks.splice(i, 1, { ...rep2, sec: 120 }, { ...rep2, sec: 120, pauseBefore: 45 });
    const r = run(blocks);
    expect(r.confidence).toBe('high');
    expect(r.steps.filter((s) => s.role === 'active').every((s) => s.verdict === 'on_target')).toBe(true);
    const rep2Step = r.steps.find((s) => s.label === 'Rep 2 of 5')!;
    expect(rep2Step.actual!.durationSec).toBeGreaterThan(225); // recorded seconds, pause excluded
    expect(rep2Step.actual!.endSec - rep2Step.actual!.startSec).toBeGreaterThan(270); // spans the pause
  });

  it('laps that do not match the plan (auto-lap every km) fall back to stream alignment', () => {
    const blocks = blocksFor();
    const streams = record(blocks);
    const laps: Lap[] = [];
    let k = 0;
    let last = 0;
    streams.distance!.forEach((d, i) => {
      if ((d ?? 0) >= (k + 1) * 1000) {
        laps.push({ index: k, startSec: last, durationSec: i - last });
        last = i;
        k++;
      }
    });
    const r = run(blocks, { laps, streams });
    expect(r.method).toBe('streams');
    expect(r.note).toMatch(/Laps don't line up/);
    expect(r.counts.onTarget).toBe(12);
  });

  it('a recording that is nothing like the plan falls back to the session totals', () => {
    const r = run([{ sec: 3300, speed: EASY * 1.05, hr: 140 }]);
    expect(r.method).toBe('session');
    expect(r.confidence).toBe('low');
    expect(r.steps).toEqual([]);
    expect(r.note).toMatch(/doesn't line up/);
  });
});

describe('analyzeExecution — laps', () => {
  it('watch-guided laps (one per step) align 1:1 with high confidence', () => {
    const blocks = blocksFor({ rep: (k) => (k === 2 ? 1000 / 285 : REP) });
    const r = run(blocks, { laps: lapsOf(blocks) });
    expect(r.method).toBe('laps');
    expect(r.confidence).toBe('high');
    expect(r.note).toBe("Laps match the plan's 12 steps");
    expect(r.steps.find((s) => s.label === 'Rep 2 of 5')!.verdict).toBe('over');
    expect(r.summary).toBe('Hit 4 of 5 reps');
  });

  it('no streams: laps that match still give per-step numbers (no time-in-target)', () => {
    const blocks = blocksFor();
    const r = run(blocks, { laps: lapsOf(blocks), streams: null });
    expect(r.method).toBe('laps');
    expect(r.counts.onTarget).toBe(12);
    expect(r.steps[1].intensity!.inTargetPct).toBeNull();
  });

  it('no streams and laps that do not match: session totals only', () => {
    const r = run(blocksFor(), { laps: [{ index: 0, startSec: 0, durationSec: 3300 }], streams: null });
    expect(r.method).toBe('session');
    expect(r.steps).toEqual([]);
    expect(r.note).toMatch(/No laps or 1 Hz recording/);
    expect(r.summary).toMatch(/^Did \d+% of the planned load$/);
  });
});

describe('analyzeExecution — other plans', () => {
  it('unstructured plan → session comparison with a score from the totals ratio', () => {
    const r = run(blocksFor(), { structure: null, load: 90 });
    expect(r.method).toBe('session');
    expect(r.note).toMatch(/no steps/);
    expect(r.score).toBe(100);
    expect(r.state).toBe('on_target');
    expect(r.counts.planned).toBe(0);
  });

  it('single steady HR step: whole session judged on HR with lag tolerated', () => {
    const structure: WorkoutStructure = { steps: [makeStep({ role: 'active', measure: { type: 'time', sec: 2700 }, target: { type: 'hr_zone', zone: 2 } })] };
    const streams = record([{ sec: 2700, speed: 2.4, hr: 154 }], { hrLag: true });
    const r = run(null, { structure, streams });
    expect(r.method).toBe('streams');
    const main = r.steps.find((s) => s.plannedIndex === 0)!;
    expect(main.label).toBe('Main set');
    expect(main.intensity!.metric).toBe('hr');
    expect(main.verdict).toBe('on_target');
    expect(r.summary).toBe('Executed as planned');
  });

  it('bike ramp on power compares start → end', () => {
    const structure: WorkoutStructure = {
      steps: [makeStep({ role: 'warmup', measure: { type: 'time', sec: 600 }, target: { type: 'ramp', basis: 'power_pct', from: 50, to: 75 } }), makeStep({ role: 'active', measure: { type: 'time', sec: 1200 }, target: { type: 'power_pct', low: 88, high: 94 } })],
    };
    const blocks: Block[] = [];
    for (let k = 0; k < 10; k++) blocks.push({ sec: 60, power: 125 + (k * 62.5) / 9, hr: 120 });
    blocks.push({ sec: 1200, power: 228, hr: 160 });
    const a = activity({ id: 'act', localDate: '2026-11-23', sport: 'bike', durationSec: 1800, movingSec: 1800, load: 50 });
    const w = planned({ id: 'wk', date: '2026-11-23', sport: 'bike', structure, plannedDurationSec: 1800, plannedLoad: 50 });
    const r = analyzeExecution({ workout: w, activity: a, laps: [], streams: record(blocks), thresholds: TH, compliance: computeCompliance(w, a, { today: '2026-11-24' }) });
    expect(r.method).toBe('streams');
    const ramp = r.steps.find((s) => s.role === 'warmup')!;
    expect(ramp.intensity!.actualStart).toBeLessThan(ramp.intensity!.actualEnd!);
    expect(ramp.intensity!.verdict).toBe('on');
    expect(r.steps.find((s) => s.role === 'active')!.verdict).toBe('on_target');
  });

  it('strength plans are compared on totals only', () => {
    const structure: WorkoutStructure = { steps: [makeStep({ role: 'active', measure: { type: 'reps', n: 8 }, strength: { exercise: 'Squat', sets: 4, reps: 8 } })] };
    const r = run(null, { structure, streams: null });
    expect(r.method).toBe('session');
    expect(r.note).toMatch(/Strength/);
  });

  it('imperial units format pace per mile', () => {
    const w = workout(intervalPlan());
    const blocks = blocksFor({ rep: 1000 / 280 });
    const a = activity({ id: 'act', localDate: '2026-11-23', durationSec: 3300, movingSec: 3300, load: 92 });
    const r = analyzeExecution({ workout: w, activity: a, streams: record(blocks), thresholds: TH, units: 'imperial', compliance: computeCompliance(w, a, { today: '2026-11-24' }) });
    expect(r.steps.find((s) => s.role === 'active')!.deviation).toMatch(/s\/mi faster than target$/);
    expect(r.steps.find((s) => s.role === 'active')!.planned!.target!.text).toBe('8:03/mi');
  });
});

describe('complianceWithExecution', () => {
  const base = { metric: 'load' as const, ratio: 1.02, state: 'on_target' as const };
  it('takes state and score from a structured analysis', () => {
    expect(complianceWithExecution(base, { method: 'streams', score: 42, state: 'off_short' })).toEqual({ ...base, state: 'off_short', score: 42 });
  });
  it('leaves totals-based compliance alone for session analyses and unpaired states', () => {
    expect(complianceWithExecution(base, { method: 'session', score: 97, state: 'on_target' })).toBe(base);
    const missed = { metric: 'load' as const, ratio: 0, state: 'missed' as const };
    expect(complianceWithExecution(missed, { method: 'streams', score: 42, state: 'off_short' })).toBe(missed);
    expect(complianceWithExecution(base, null)).toBe(base);
  });
});
