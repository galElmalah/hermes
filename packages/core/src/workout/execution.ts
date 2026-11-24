/**
 * Workout execution: plan vs actual, step by step.
 *
 * Given a planned workout's structure and the paired activity's laps / 1 Hz streams, find which
 * part of the recording executed which planned step, judge every step against its target (in the
 * target's own metric) and its planned duration or distance, and roll that up into an adherence
 * score, a coarse compliance state and a one-line summary. The response shape is
 * `ExecutionAnalysis` (domain.ts) and is documented for clients in docs/MOBILE_API.md §4.
 *
 * Alignment, in order of preference:
 *  1. laps — the recording has one lap per planned step (watch-guided workout or manual lap
 *     presses) and the lap durations follow the plan → 1:1, confidence high;
 *  2. streams — the recording is cut into homogeneous segments on the target metric (binary
 *     segmentation + merging, with lap marks and pauses as extra cut points) and the planned steps
 *     are aligned to runs of consecutive segments by dynamic programming. A step may span several
 *     segments, a step may be skipped, a segment may be "extra" (late start, walk before the
 *     warm-up, an added block, a stop at the end). Confidence comes from how well durations fit,
 *     whether hard steps really were harder than the recoveries next to them, and how much was
 *     skipped / extra;
 *  3. session — no structure, nothing measurable, or no trustworthy alignment: totals only, with no
 *     per-step numbers.
 */
import type {
  Activity,
  ActivityStreams,
  Compliance,
  ComplianceState,
  ExecutionAnalysis,
  ExecutionMetric,
  ExecutionStep,
  ExecutionTarget,
  ExecutionVerdict,
  Lap,
  PlannedWorkout,
  Sport,
  Step,
  StepRole,
  Target,
  ThresholdSnapshot,
} from '../domain';
import { stateForRatio } from './compliance';
import { estimateStep } from './estimate';
import { PACE_UNIT_M, fmtClock, fmtDistance, fmtNum, fmtPace, fmtRange, paceUnitFor, type Units } from './format';
import { flattenStructure, type FlatStep } from './structure';
import { HR_ZONE_PCT_LTHR, POWER_ZONE_PCT, rowSpeedFromPower } from './tables';
import { targetShort } from './title';

export const EXECUTION_VERSION = 1;

/** Role weights for the overall score (× planned seconds). */
export const ROLE_WEIGHT: Record<StepRole, number> = {
  active: 1,
  other: 0.75,
  warmup: 0.4,
  cooldown: 0.4,
  recovery: 0.4,
  rest: 0.25,
};

const EASY_ROLES: ReadonlySet<StepRole> = new Set(['warmup', 'cooldown', 'recovery', 'rest']);

/** Point targets are widened by this tolerance (fraction, or bpm for HR). */
const POINT_TOL: Record<ExecutionMetric, number> = { speed: 0.025, power: 0.03, hr: 3, cadence: 0.025 };
/** Grace on range edges for the "on" verdict (fraction). */
const RANGE_GRACE = 0.01;
/** Deviation outside the band (fraction) at which the intensity score reaches 0. */
const ZERO_AT: Record<ExecutionMetric, number> = { speed: 0.08, power: 0.12, hr: 0.08, cadence: 0.1 };
/** Same, for easy steps going easier than planned (gentler). */
const EASY_UNDER_ZERO_AT = 0.4;
/** Minimum meaningful level change per metric (segment merging, heterogeneity). */
const DELTA_MIN: Record<ExecutionMetric, number> = { speed: 0.12, power: 15, hr: 6, cadence: 5 };

export interface ExecutionInput {
  workout: Pick<PlannedWorkout, 'id' | 'sport' | 'structure' | 'plannedDurationSec' | 'plannedDistanceM' | 'plannedLoad'>;
  activity: Pick<Activity, 'id' | 'sport' | 'durationSec' | 'movingSec' | 'distanceM' | 'load'>;
  laps?: readonly Lap[];
  streams?: ActivityStreams | null;
  /** Thresholds effective on the workout date (resolve %-targets). */
  thresholds: ThresholdSnapshot;
  units?: Units;
  /** Totals-based compliance (computeCompliance) — used for the session fallback. */
  compliance: Compliance;
}

// ───────────────────────────── planned steps ─────────────────────────────

interface PlanStep {
  index: number;
  flat: FlatStep;
  step: Step;
  role: StepRole;
  label: string;
  repeat: { iteration: number; count: number } | null;
  inRepeat: boolean;
  measure: Step['measure']['type'];
  /** Planned seconds (time steps). */
  plannedSec: number | null;
  /** Planned metres (distance steps). */
  plannedM: number | null;
  /** Estimated seconds / metres (always set; distance only for distance sports). */
  estSec: number;
  estM: number | null;
  target: ExecutionTarget | null;
  targetText: string | null;
  /** True when the planned target is a single value (widened band). */
  point: boolean;
  ramp: boolean;
  easy: boolean;
}

const ROLE_LABEL: Record<StepRole, string> = {
  warmup: 'Warm-up',
  active: 'Rep',
  recovery: 'Recovery',
  rest: 'Rest',
  cooldown: 'Cool-down',
  other: 'Step',
};

function paceText(mps: number, sport: Sport, units: Units): string {
  return fmtPace(PACE_UNIT_M[paceUnitFor(sport, units, sport === 'swim' && units === 'imperial')] / mps);
}

function paceUnit(sport: Sport, units: Units): string {
  return paceUnitFor(sport, units, sport === 'swim' && units === 'imperial');
}

function nativeText(metric: ExecutionMetric, lo: number, hi: number, sport: Sport, units: Units): string {
  const r0 = (x: number) => fmtNum(Math.round(x));
  switch (metric) {
    case 'speed':
      return `${fmtRange(paceText(hi, sport, units), paceText(lo, sport, units))}/${paceUnit(sport, units)}`;
    case 'power':
      return `${fmtRange(r0(lo), r0(hi))} W`;
    case 'hr':
      return `${fmtRange(r0(lo), r0(hi))} bpm`;
    case 'cadence':
      return `${fmtRange(r0(lo), r0(hi))} ${sport === 'run' || sport === 'walk' || sport === 'hike' ? 'spm' : 'rpm'}`;
  }
}

function speedThreshold(sport: Sport, th: ThresholdSnapshot): number | undefined {
  if (sport === 'run' || sport === 'walk' || sport === 'hike') return th.runThresholdMps;
  if (sport === 'swim') return th.swimCssMps;
  if (sport === 'row') return th.rowThresholdW ? rowSpeedFromPower(th.rowThresholdW) : undefined;
  return undefined;
}

function powerThreshold(sport: Sport, th: ThresholdSnapshot): number | undefined {
  return sport === 'row' ? th.rowThresholdW : sport === 'bike' ? th.ftp : th.ftp;
}

function lthrOf(th: ThresholdSnapshot): number | undefined {
  return th.lthr ?? (th.hrMax ? 0.9 * th.hrMax : undefined);
}

/** A target in native units, or null when it is not measurable (open, RPE, missing threshold). */
export function resolveExecutionTarget(
  t: Target | undefined,
  sport: Sport,
  th: ThresholdSnapshot,
  units: Units = 'metric',
): { target: ExecutionTarget | null; text: string | null; point: boolean; ramp: boolean } {
  if (!t || t.type === 'open') return { target: null, text: null, point: false, ramp: false };
  const short = targetShort(t, sport, units);
  let metric: ExecutionMetric | null = null;
  let lo = 0;
  let hi = 0;
  let from: number | undefined;
  let to: number | undefined;
  let text = short;
  switch (t.type) {
    case 'rpe':
      return { target: null, text: short, point: false, ramp: false };
    case 'pace':
      metric = 'speed';
      lo = t.lowMps;
      hi = t.highMps;
      break;
    case 'pace_pct': {
      const thr = speedThreshold(sport, th);
      if (!thr) return { target: null, text: short, point: false, ramp: false };
      metric = 'speed';
      lo = (t.low / 100) * thr;
      hi = (t.high / 100) * thr;
      break;
    }
    case 'power_w':
      metric = 'power';
      lo = t.low;
      hi = t.high;
      break;
    case 'power_pct': {
      const thr = powerThreshold(sport, th);
      if (!thr) return { target: null, text: short, point: false, ramp: false };
      metric = 'power';
      lo = (t.low / 100) * thr;
      hi = (t.high / 100) * thr;
      break;
    }
    case 'hr_bpm':
      metric = 'hr';
      lo = t.low;
      hi = t.high;
      break;
    case 'hr_pct_lthr':
    case 'hr_zone': {
      const lthr = lthrOf(th);
      if (!lthr) return { target: null, text: short, point: false, ramp: false };
      const [a, b] = t.type === 'hr_zone' ? (HR_ZONE_PCT_LTHR[t.zone] ?? [0, 0]) : [t.low, t.high];
      metric = 'hr';
      lo = (a / 100) * lthr;
      hi = (b / 100) * lthr;
      break;
    }
    case 'cadence':
      metric = 'cadence';
      lo = t.low;
      hi = t.high;
      break;
    case 'ramp': {
      let k: number | undefined;
      if (t.basis === 'power_pct') {
        metric = 'power';
        k = powerThreshold(sport, th);
      } else if (t.basis === 'pace_pct') {
        metric = 'speed';
        k = speedThreshold(sport, th);
      } else {
        metric = 'hr';
        k = lthrOf(th);
      }
      if (!k) return { target: null, text: short, point: false, ramp: true };
      from = (t.from / 100) * k;
      to = (t.to / 100) * k;
      lo = Math.min(from, to);
      hi = Math.max(from, to);
      break;
    }
  }
  if (!metric || !(hi > 0)) return { target: null, text: short, point: false, ramp: false };
  if (lo > hi) [lo, hi] = [hi, lo];
  const ramp = from !== undefined && to !== undefined;
  const point = !ramp && (hi - lo) / ((hi + lo) / 2) < 0.005;
  let bandLo = lo;
  let bandHi = hi;
  if (point) {
    const tol = POINT_TOL[metric];
    bandLo = metric === 'hr' ? lo - tol : lo * (1 - tol);
    bandHi = metric === 'hr' ? hi + tol : hi * (1 + tol);
  }
  // Display text: native values, with the relative form first when the plan was relative.
  if (ramp) {
    const f = (x: number) => (metric === 'speed' ? paceText(x, sport, units) : fmtNum(Math.round(x)));
    const unit = metric === 'speed' ? `/${paceUnit(sport, units)}` : metric === 'power' ? ' W' : ' bpm';
    text = `${short} · ${f(from!)}→${f(to!)}${unit}`;
  } else {
    const native = nativeText(metric, lo, hi, sport, units);
    const relative = t.type === 'pace_pct' || t.type === 'power_pct' || t.type === 'hr_pct_lthr' || t.type === 'hr_zone';
    text = relative ? `${short} · ${native}` : native;
    if (t.type === 'power_pct' && sport === 'bike') {
      const z = Object.entries(POWER_ZONE_PCT).find(([, [a, b]]) => a === t.low && b === t.high);
      if (z) text = `Z${z[0]} · ${native}`;
    }
  }
  const target: ExecutionTarget = { metric, low: bandLo, high: bandHi, plannedLow: lo, plannedHigh: hi, text };
  if (ramp) {
    target.from = from;
    target.to = to;
  }
  return { target, text, point, ramp };
}

function buildPlan(input: ExecutionInput, units: Units): PlanStep[] {
  const { workout, thresholds } = input;
  const sport = workout.sport;
  if (!workout.structure) return [];
  const flat = flattenStructure(workout.structure);
  const occurrences = new Map<string, number>();
  for (const f of flat) occurrences.set(f.step.id, (occurrences.get(f.step.id) ?? 0) + 1);
  const seen = new Map<string, number>();
  const activeTop = flat.filter((f) => f.step.role === 'active' && f.repeatIds.length === 0).length;
  let topActive = 0;
  return flat.map((f, index) => {
    const step = f.step;
    const est = estimateStep(step, sport, thresholds);
    const occ = (seen.get(step.id) ?? 0) + 1;
    seen.set(step.id, occ);
    const total = occurrences.get(step.id) ?? 1;
    const inRepeat = f.repeatIds.length > 0;
    let label: string;
    const base = step.label?.trim() || ROLE_LABEL[step.role];
    if (inRepeat && total > 1) label = `${base} ${occ} of ${total}`;
    else if (step.role === 'active' && !step.label) label = activeTop > 1 ? `Block ${++topActive}` : 'Main set';
    else label = base;
    const r = resolveExecutionTarget(step.target, sport, thresholds, units);
    const m = step.measure;
    return {
      index,
      flat: f,
      step,
      role: step.role,
      label,
      repeat: inRepeat && total > 1 ? { iteration: occ, count: total } : null,
      inRepeat,
      measure: m.type,
      plannedSec: m.type === 'time' ? m.sec : null,
      plannedM: m.type === 'distance' ? m.m : null,
      estSec: Math.max(1, est.durationSec),
      estM: est.distanceM ?? null,
      target: r.target,
      targetText: r.text,
      point: r.point,
      ramp: r.ramp,
      easy: EASY_ROLES.has(step.role),
    };
  });
}

// ───────────────────────────── recording ─────────────────────────────

interface Rec {
  n: number;
  t: Float64Array;
  ch: Partial<Record<ExecutionMetric, Float64Array>>;
  dist?: Float64Array;
}

function toF64(a: ReadonlyArray<number | null> | undefined, n: number): Float64Array | undefined {
  if (!a) return undefined;
  const out = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    const v = a[i];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[i] = v;
      any = true;
    } else out[i] = NaN;
  }
  return any ? out : undefined;
}

function buildRec(s: ActivityStreams | null | undefined): Rec | null {
  if (!s || !s.t?.length || s.t.length < 30) return null;
  const n = s.t.length;
  const t = Float64Array.from(s.t);
  const dist = toF64(s.distance, n);
  let speed = toF64(s.speed, n);
  if (!speed && dist) {
    // Speed from distance (centred 5 s difference).
    speed = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 2);
      const b = Math.min(n - 1, i + 2);
      const dt = t[b] - t[a];
      speed[i] = dt > 0 && Number.isFinite(dist[b]) && Number.isFinite(dist[a]) ? (dist[b] - dist[a]) / dt : NaN;
    }
  }
  const ch: Rec['ch'] = {};
  if (speed) ch.speed = speed;
  const power = toF64(s.power, n);
  if (power) ch.power = power;
  const hr = toF64(s.hr, n);
  if (hr) ch.hr = hr;
  const cad = toF64(s.cadence, n);
  if (cad) ch.cadence = cad;
  return { n, t, ch, dist };
}

function coverage(x: Float64Array | undefined): number {
  if (!x) return 0;
  let c = 0;
  for (let i = 0; i < x.length; i++) if (Number.isFinite(x[i])) c++;
  return c / x.length;
}

/** Centred rolling mean ignoring NaN (window w). */
function smooth(x: Float64Array, w: number): Float64Array {
  if (w <= 1) return x;
  const n = x.length;
  const h = Math.floor(w / 2);
  const out = new Float64Array(n);
  let sum = 0;
  let cnt = 0;
  let lo = 0;
  let hi = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h);
    const b = Math.min(n - 1, i + h);
    while (hi < b) {
      hi++;
      if (Number.isFinite(x[hi])) (sum += x[hi]), cnt++;
    }
    while (lo < a) {
      if (Number.isFinite(x[lo])) (sum -= x[lo]), cnt--;
      lo++;
    }
    out[i] = cnt ? sum / cnt : NaN;
  }
  return out;
}

/** Fill NaN with the previous valid value (leading NaN with the first valid). */
function filled(x: Float64Array): Float64Array {
  const out = Float64Array.from(x);
  let first = NaN;
  for (let i = 0; i < out.length; i++)
    if (Number.isFinite(out[i])) {
      first = out[i];
      break;
    }
  let prev = Number.isFinite(first) ? first : 0;
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i])) prev = out[i];
    else out[i] = prev;
  }
  return out;
}

// ───────────────────────────── segments ─────────────────────────────

interface Seg {
  /** Sample range [a, b) — or, for lap segments without streams, the lap index. */
  a: number;
  b: number;
  startSec: number;
  endSec: number;
  sec: number;
  distM: number | null;
  sum: Record<ExecutionMetric, number>;
  cnt: Record<ExecutionMetric, number>;
}

const METRICS: readonly ExecutionMetric[] = ['speed', 'power', 'hr', 'cadence'];

function zeroRec(): Record<ExecutionMetric, number> {
  return { speed: 0, power: 0, hr: 0, cadence: 0 };
}

function segOf(rec: Rec, a: number, b: number): Seg {
  const sum = zeroRec();
  const cnt = zeroRec();
  for (const m of METRICS) {
    const x = rec.ch[m];
    if (!x) continue;
    for (let i = a; i < b; i++) {
      const v = x[i];
      if (Number.isFinite(v) && !(m === 'cadence' && v <= 0)) (sum[m] += v), cnt[m]++;
    }
  }
  let distM: number | null = null;
  if (rec.dist) {
    let d0 = NaN;
    let d1 = NaN;
    for (let i = a; i < b && !Number.isFinite(d0); i++) d0 = rec.dist[i];
    for (let i = b - 1; i >= a && !Number.isFinite(d1); i--) d1 = rec.dist[i];
    // Include the step into the first sample: distance at the end of the previous sample.
    if (a > 0 && Number.isFinite(rec.dist[a - 1])) d0 = rec.dist[a - 1];
    if (Number.isFinite(d0) && Number.isFinite(d1)) distM = Math.max(0, d1 - d0);
  }
  if (distM === null && cnt.speed > 0) distM = (sum.speed / cnt.speed) * (b - a);
  return { a, b, startSec: rec.t[a], endSec: rec.t[b - 1] + 1, sec: b - a, distM, sum, cnt };
}

function segMean(s: Pick<Seg, 'sum' | 'cnt'>, m: ExecutionMetric): number {
  return s.cnt[m] > 0 ? s.sum[m] / s.cnt[m] : NaN;
}

/** Binary segmentation of x[a, b) into piecewise-constant pieces; returns cut indices. */
function binarySegment(x: Float64Array, a: number, b: number, minLen: number, penalty: number, out: number[], depth = 0): void {
  const n = b - a;
  if (n < 2 * minLen || depth > 24) return;
  let total = 0;
  for (let i = a; i < b; i++) total += x[i];
  let left = 0;
  let best = -1;
  let bestGain = 0;
  for (let k = a + 1; k < b; k++) {
    left += x[k - 1];
    const n1 = k - a;
    const n2 = b - k;
    if (n1 < minLen || n2 < minLen) continue;
    const right = total - left;
    const gain = (left * left) / n1 + (right * right) / n2 - (total * total) / n;
    if (gain > bestGain) {
      bestGain = gain;
      best = k;
    }
  }
  if (best < 0 || bestGain <= penalty) return;
  out.push(best);
  binarySegment(x, a, best, minLen, penalty, out, depth + 1);
  binarySegment(x, best, b, minLen, penalty, out, depth + 1);
}

function segmentStreams(rec: Rec, metric: ExecutionMetric, laps: readonly Lap[], deltaMin: number): Seg[] {
  const raw = rec.ch[metric]!;
  const x = filled(metric === 'hr' ? raw : smooth(raw, metric === 'power' ? 9 : 5));
  const n = rec.n;
  // Forced cut points: pauses (gaps in t) and lap starts.
  const forced = new Set<number>();
  for (let i = 1; i < n; i++) if (rec.t[i] - rec.t[i - 1] > 3) forced.add(i);
  for (const l of laps) {
    if (l.startSec <= rec.t[0]) continue;
    let k = 0;
    while (k < n && rec.t[k] < l.startSec) k++;
    if (k > 0 && k < n) forced.add(k);
  }
  const pieces = [0, ...[...forced].sort((p, q) => p - q), n];
  const cuts: number[] = [];
  const minLen = 10;
  const penalty = 5 * deltaMin * deltaMin;
  for (let i = 0; i + 1 < pieces.length; i++) {
    const a = pieces[i];
    const b = pieces[i + 1];
    if (b <= a) continue;
    if (a > 0) cuts.push(a);
    binarySegment(x, a, b, minLen, penalty, cuts);
  }
  const bounds = [...new Set([0, ...cuts, n])].sort((p, q) => p - q);
  // Mean of the boundary signal per piece (on the filled signal so every piece has a level).
  let segs = bounds.slice(0, -1).map((a, i) => ({ a, b: bounds[i + 1] }));
  const level = (s: { a: number; b: number }) => {
    let sum = 0;
    for (let i = s.a; i < s.b; i++) sum += x[i];
    return sum / Math.max(1, s.b - s.a);
  };
  // Merge: tiny pieces into the closer neighbour, then adjacent pieces closer than deltaMin.
  const merge = (thr: number) => {
    for (;;) {
      if (segs.length < 2) return;
      let bi = -1;
      let bd = Infinity;
      for (let i = 0; i + 1 < segs.length; i++) {
        const d = Math.abs(level(segs[i]) - level(segs[i + 1]));
        const tiny = segs[i].b - segs[i].a < minLen || segs[i + 1].b - segs[i + 1].a < minLen;
        const eff = tiny ? d - 1e9 : d;
        if (eff < bd) {
          bd = eff;
          bi = i;
        }
      }
      if (bd >= thr) return;
      segs = [...segs.slice(0, bi), { a: segs[bi].a, b: segs[bi + 1].b }, ...segs.slice(bi + 2)];
    }
  };
  merge(deltaMin);
  let thr = deltaMin;
  while (segs.length > 240) {
    thr *= 1.5;
    merge(thr);
  }
  return segs.map((s) => segOf(rec, s.a, s.b));
}

function lapSegments(laps: readonly Lap[], rec: Rec | null): Seg[] {
  const out: Seg[] = [];
  laps.forEach((l, i) => {
    const next = laps[i + 1];
    if (rec) {
      const endT = next ? next.startSec : l.startSec + l.durationSec;
      let a = 0;
      while (a < rec.n && rec.t[a] < l.startSec) a++;
      let b = a;
      while (b < rec.n && rec.t[b] < endT) b++;
      if (i === laps.length - 1) b = Math.max(b, rec.n);
      if (b > a) out.push(segOf(rec, a, b));
      return;
    }
    const sec = l.movingSec ?? l.durationSec;
    const sum = zeroRec();
    const cnt = zeroRec();
    const put = (m: ExecutionMetric, v: number | undefined) => {
      if (v !== undefined && Number.isFinite(v)) (sum[m] = v * sec), (cnt[m] = sec);
    };
    put('speed', l.avgSpeedMps ?? (l.distanceM !== undefined && sec > 0 ? l.distanceM / sec : undefined));
    put('power', l.avgPower);
    put('hr', l.avgHr);
    put('cadence', l.avgCadence);
    out.push({ a: i, b: i + 1, startSec: l.startSec, endSec: l.startSec + l.durationSec, sec, distM: l.distanceM ?? null, sum, cnt });
  });
  return out;
}

// ───────────────────────────── alignment ─────────────────────────────

interface Assignment {
  /** Per plan step: [first segment, end segment) or null when skipped. */
  runs: ({ j0: number; j1: number } | null)[];
  /** Segment index → true when it is extra. */
  extra: boolean[];
}

function outsideRel(v: number, lo: number, hi: number): { dev: number; under: boolean } {
  if (v < lo) return { dev: (lo - v) / lo, under: true };
  if (v > hi) return { dev: (v - hi) / hi, under: false };
  return { dev: 0, under: false };
}

interface Acc {
  conflict: number;
  below: number;
  above: number;
  devSum: number;
  devSec: number;
}

interface AlignContext {
  plan: PlanStep[];
  segs: Seg[];
  boundary: ExecutionMetric | null;
  /** Lowest band of the hard (active) steps in the boundary metric. */
  hardRef: number | null;
  /** Highest band of the easy steps in the boundary metric. */
  easyRef: number | null;
  medianSec: number;
}

function alignDP(ctx: AlignContext, opts: { allowMulti: boolean }): Assignment {
  const { plan, segs, boundary } = ctx;
  const K = plan.length;
  const M = segs.length;
  // Prefix sums over segments.
  const P = (f: (s: Seg) => number) => {
    const a = new Float64Array(M + 1);
    for (let j = 0; j < M; j++) a[j + 1] = a[j] + f(segs[j]);
    return a;
  };
  const sec = P((s) => s.sec);
  const dist = P((s) => s.distM ?? 0);
  const sums = Object.fromEntries(METRICS.map((m) => [m, P((s) => s.sum[m])])) as Record<ExecutionMetric, Float64Array>;
  const cnts = Object.fromEntries(METRICS.map((m) => [m, P((s) => s.cnt[m])])) as Record<ExecutionMetric, Float64Array>;
  const bMean = segs.map((s) => (boundary ? segMean(s, boundary) : NaN));
  const bw = P((s) => (boundary && Number.isFinite(segMean(s, boundary)) ? s.sec : 0));
  const bw1 = P((s) => (boundary && Number.isFinite(segMean(s, boundary)) ? s.sec * segMean(s, boundary) : 0));
  const bw2 = P((s) => (boundary && Number.isFinite(segMean(s, boundary)) ? s.sec * segMean(s, boundary) ** 2 : 0));
  const dMin = boundary ? DELTA_MIN[boundary] : 1;

  const segEasy = (j: number): boolean => {
    const v = bMean[j];
    if (!Number.isFinite(v)) return false;
    if (ctx.easyRef !== null) return v <= ctx.easyRef * 1.02;
    if (ctx.hardRef !== null) return v < ctx.hardRef * 0.85;
    return false;
  };
  const SKIP = 3;
  const extraCost = (j: number, edge: boolean) =>
    (0.1 + 1.5 * Math.min(1, segs[j].sec / ctx.medianSec)) * (edge ? 0.5 : 1) * (segEasy(j) ? 0.5 : 1);

  // Class levels in the boundary metric: a step's own level and the opposite class's level
  // (hard steps vs easy ones). A segment closer to the opposite level "conflicts" with the step.
  const easyLevel = ctx.easyRef ?? (ctx.hardRef !== null ? ctx.hardRef * 0.75 : null);
  const levels = plan.map((p) => {
    let own: number | null = null;
    if (p.target && p.target.metric === boundary) own = (p.target.low + p.target.high) / 2;
    else if (p.easy) own = easyLevel;
    else if (p.role === 'active') own = ctx.hardRef;
    const opp = p.easy ? ctx.hardRef : p.role === 'active' ? easyLevel : null;
    return own !== null && opp !== null && Math.abs(own - opp) > dMin ? { own, opp } : null;
  });
  const conflicting = (i: number, j: number): number => {
    const lv = levels[i];
    const v = bMean[j];
    if (!lv || !Number.isFinite(v) || segs[j].sec <= 15) return 0;
    return Math.abs(v - lv.opp) < Math.abs(v - lv.own) ? segs[j].sec : 0;
  };

  /** Seconds of segment j clearly below / above step i's band (boundary metric). */
  const side = (i: number, j: number): -1 | 0 | 1 => {
    const t = plan[i].target;
    const v = bMean[j];
    if (!t || t.metric !== boundary || plan[i].ramp || !Number.isFinite(v)) return 0;
    return v < t.low * 0.97 ? -1 : v > t.high * 1.03 ? 1 : 0;
  };

  /** Intensity misfit of one segment for step i (0 inside the band, 1 per 5 % outside, capped). */
  const segDev = (i: number, j: number): number => {
    const p = plan[i];
    const t = p.target!;
    const v = segMean(segs[j], t.metric);
    if (!Number.isFinite(v)) return NaN;
    const o = outsideRel(v, t.low, t.high);
    return Math.min(3, (o.dev / 0.05) * (o.under && p.easy ? 0.1 : 1)); // an easy step done easier is still the right block
  };

  const matchCost = (i: number, j: number, L: number, acc: Acc, expectSec?: number): number => {
    const p = plan[i];
    const e = j + L;
    const runSec = sec[e] - sec[j];
    let cost = 0;
    // intensity
    if (p.target) {
      // Time-weighted misfit of the segments (not of their mean: a walk plus a fast run must not
      // average into the target).
      cost += acc.devSec > 0 ? acc.devSum / acc.devSec : 1;
    } else if (p.easy && boundary && ctx.hardRef !== null) {
      const w = bw[e] - bw[j];
      if (w > 0) {
        const v = (bw1[e] - bw1[j]) / w;
        cost += Math.min(3, (Math.max(0, v - ctx.hardRef * 0.95) / (0.05 * ctx.hardRef)) * 0.5);
      }
    }
    // duration / distance
    let dD = 0;
    if (expectSec !== undefined) dD = Math.abs(Math.log(Math.max(1, runSec) / expectSec));
    else if (p.plannedSec !== null) dD = Math.abs(Math.log(Math.max(1, runSec) / p.plannedSec));
    else if (p.plannedM !== null) {
      const dm = dist[e] - dist[j];
      dD = dm > 0 ? Math.abs(Math.log(dm / p.plannedM)) : Math.abs(Math.log(Math.max(1, runSec) / p.estSec));
    } else if (p.measure === 'lap_button') dD = 0.3 * Math.abs(Math.log(Math.max(1, runSec) / p.estSec));
    cost += 1.2 * Math.min(3, dD);
    // heterogeneity (several segments merged into one step): for a targeted step, blocks on both
    // sides of its band (a walk and a run averaging to the target); otherwise the spread of levels.
    if (L > 1 && !p.ramp && boundary) {
      const targeted = !!p.target && p.target.metric === boundary;
      const w = bw[e] - bw[j];
      if (w > 0) {
        const mu = (bw1[e] - bw1[j]) / w;
        const sd = Math.sqrt(Math.max(0, (bw2[e] - bw2[j]) / w - mu * mu));
        cost += Math.min(3, (sd / dMin) * (targeted ? 0.1 : 0.5));
      }
      if (targeted) cost += (boundary === 'hr' || boundary === 'cadence' ? 3 : 10) * (Math.min(acc.below, acc.above) / Math.max(1, runSec));
    }
    // part of a hard block inside an easy step (or the reverse)
    if (acc.conflict > 0) cost += 4 * Math.min(1, acc.conflict / Math.max(1, runSec));
    return cost;
  };

  const W = M + 1;
  const dp = new Float64Array((K + 1) * W).fill(Infinity);
  const from = new Int32Array((K + 1) * W).fill(-1);
  const kind = new Int8Array((K + 1) * W); // 1 skip, 2 extra, 3 match, 4 jog-through (easy, hard skipped, easy)
  // "Jogged through" a hard step: easy i, hard i+1 (skipped), easy i+2 share one easy block.
  const between = (p: PlanStep) => p.role === 'recovery' || p.role === 'rest';
  const jogThrough = plan.map((p, i) => i + 2 < K && between(p) && between(plan[i + 2]) && !plan[i + 1].easy && p.target?.metric === plan[i + 2].target?.metric);
  const secOf = (p: PlanStep) => p.plannedSec ?? p.estSec;
  dp[0] = 0;
  for (let i = 0; i <= K; i++) {
    for (let j = 0; j <= M; j++) {
      const cur = dp[i * W + j];
      if (!Number.isFinite(cur)) continue;
      const relax = (ni: number, nj: number, c: number, k: number) => {
        const idx = ni * W + nj;
        if (cur + c < dp[idx] - 1e-12) {
          dp[idx] = cur + c;
          from[idx] = i * W + j;
          kind[idx] = k;
        }
      };
      // Skipping late steps (cut short) is more plausible than skipping early ones.
      if (i < K) relax(i + 1, j, SKIP + 0.2 * (1 - i / K), 1);
      if (j < M) relax(i, j + 1, extraCost(j, i === 0 || i === K), 2);
      if (i < K) {
        const p = plan[i];
        const cap = (p.plannedSec ?? p.estSec) * 3 + 180;
        const maxL = opts.allowMulti ? 60 : 1;
        const acc: Acc = { conflict: 0, below: 0, above: 0, devSum: 0, devSec: 0 };
        for (let L = 1; L <= maxL && j + L <= M; L++) {
          const jj = j + L - 1;
          if (p.target) {
            const d = segDev(i, jj);
            if (Number.isFinite(d)) (acc.devSum += d * segs[jj].sec), (acc.devSec += segs[jj].sec);
          }
          acc.conflict += conflicting(i, jj);
          const sd = side(i, jj);
          if (sd < 0) acc.below += segs[jj].sec;
          else if (sd > 0) acc.above += segs[jj].sec;
          relax(i + 1, j + L, matchCost(i, j, L, acc), 3);
          if (jogThrough[i]) {
            // Only when the easy block plausibly covers all three steps.
            const expect = secOf(p) + secOf(plan[i + 1]) + secOf(plan[i + 2]);
            const r = (sec[j + L] - sec[j]) / expect;
            if (r >= 0.7 && r <= 1.5) relax(i + 3, j + L, matchCost(i, j, L, acc, expect) + SKIP, 4);
          }
          if (sec[j + L] - sec[j] > (jogThrough[i] ? cap * 3 : cap) && p.measure !== 'lap_button') break;
        }
      }
    }
  }
  // Backtrack.
  const runs: Assignment['runs'] = new Array(K).fill(null);
  const extra = new Array<boolean>(M).fill(false);
  let idx = K * W + M;
  while (idx > 0) {
    const prev = from[idx];
    if (prev < 0) break;
    const i = Math.floor(idx / W);
    const j = idx % W;
    const pi = Math.floor(prev / W);
    const pj = prev % W;
    if (kind[idx] === 2) extra[pj] = true;
    else if (kind[idx] === 3 || kind[idx] === 4) runs[pi] = { j0: pj, j1: j }; // 4: i+1, i+2 stay null; splitShared shares the block
    void i;
    idx = prev;
  }
  return { runs, extra };
}

// ───────────────────────────── measuring a step ─────────────────────────────

interface Window {
  /** Sample range when streams exist. */
  a?: number;
  b?: number;
  seg: Seg; // aggregate (union of segments)
}

function unionSeg(segs: Seg[], j0: number, j1: number): Seg {
  const sum = zeroRec();
  const cnt = zeroRec();
  let secs = 0;
  let distM: number | null = 0;
  for (let j = j0; j < j1; j++) {
    const s = segs[j];
    for (const m of METRICS) (sum[m] += s.sum[m]), (cnt[m] += s.cnt[m]);
    secs += s.sec;
    distM = distM !== null && s.distM !== null ? distM + s.distM : null;
  }
  return { a: segs[j0].a, b: segs[j1 - 1].b, startSec: segs[j0].startSec, endSec: segs[j1 - 1].endSec, sec: secs, distM, sum, cnt };
}

function round(x: number, dp = 0): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

function measure(p: PlanStep | null, w: Window, rec: Rec | null, sport: Sport, units: Units) {
  const s = w.seg;
  const avg = (m: ExecutionMetric) => {
    const v = segMean(s, m);
    return Number.isFinite(v) ? v : null;
  };
  const avgSpeed = s.distM !== null && s.sec > 0 && s.distM > 0 ? s.distM / s.sec : avg('speed');
  const actual: NonNullable<ExecutionStep['actual']> = {
    startSec: round(s.startSec, 1),
    endSec: round(s.endSec, 1),
    durationSec: round(s.sec),
    distanceM: s.distM !== null ? round(s.distM, 1) : null,
    avgSpeedMps: avgSpeed !== null ? round(avgSpeed, 3) : null,
    avgHr: avg('hr') !== null ? round(avg('hr')!) : null,
    avgPower: avg('power') !== null ? round(avg('power')!) : null,
    avgCadence: avg('cadence') !== null ? round(avg('cadence')!) : null,
  };
  if (!p) return { actual, intensity: null, duration: null, sI: null as number | null, sD: null as number | null };

  // ── intensity
  let intensity: ExecutionStep['intensity'] = null;
  let sI: number | null = null;
  const t = p.target;
  if (t) {
    const m = t.metric;
    const v = m === 'speed' ? avgSpeed : avg(m);
    if (v !== null && Number.isFinite(v)) {
      let delta: number;
      let deltaPct: number;
      let verdict: 'on' | 'over' | 'under';
      let dev: number; // fraction outside the band, for the score
      let actualStart: number | undefined;
      let actualEnd: number | undefined;
      let ref: number;
      const hasSamples = rec && w.a !== undefined && w.b !== undefined && rec.ch[m];
      if (p.ramp && t.from !== undefined && t.to !== undefined) {
        const series = hasSamples ? rec!.ch[m]! : null;
        if (series) {
          const n = w.b! - w.a!;
          const k = Math.max(1, Math.round(n * 0.2));
          const mean = (a: number, b: number) => {
            let sum = 0;
            let c = 0;
            for (let i = a; i < b; i++) if (Number.isFinite(series[i])) (sum += series[i]), c++;
            return c ? sum / c : v;
          };
          actualStart = mean(w.a!, w.a! + k);
          actualEnd = mean(w.b! - k, w.b!);
        } else {
          actualStart = v;
          actualEnd = v;
        }
        const tol = m === 'hr' ? POINT_TOL.hr / ((t.from + t.to) / 2) : POINT_TOL[m];
        const ds = (actualStart - t.from) / t.from;
        const de = (actualEnd - t.to) / t.to;
        const avgDev = (ds + de) / 2;
        ref = (t.from + t.to) / 2;
        deltaPct = Math.abs(avgDev) <= tol ? 0 : avgDev;
        delta = deltaPct * ref;
        verdict = deltaPct === 0 ? 'on' : deltaPct > 0 ? 'over' : 'under';
        dev = Math.max(0, Math.abs(avgDev) - tol);
      } else {
        const loG = t.low * (1 - RANGE_GRACE);
        const hiG = t.high * (1 + RANGE_GRACE);
        if (v >= loG && v <= hiG) {
          verdict = 'on';
          delta = 0;
          deltaPct = 0;
          dev = 0;
          ref = v;
        } else {
          const over = v > hiG;
          verdict = over ? 'over' : 'under';
          // Point targets: measured from the planned point; ranges: from the nearest edge.
          ref = p.point ? t.plannedLow : over ? t.plannedHigh : t.plannedLow;
          delta = v - ref;
          deltaPct = delta / ref;
          dev = outsideRel(v, t.low, t.high).dev;
        }
      }
      // time in target
      let inTargetPct: number | null = null;
      if (hasSamples) {
        const raw = rec!.ch[m]!;
        const x = m === 'hr' ? raw : smooth(raw, 5);
        let inside = 0;
        let c = 0;
        const n = w.b! - w.a!;
        for (let i = w.a!; i < w.b!; i++) {
          const xv = x[i];
          if (!Number.isFinite(xv)) continue;
          c++;
          let lo = t.low;
          let hi = t.high;
          if (p.ramp && t.from !== undefined && t.to !== undefined) {
            const f = n > 1 ? (i - w.a!) / (n - 1) : 0.5;
            const mid = t.from + (t.to - t.from) * f;
            const tol = m === 'hr' ? POINT_TOL.hr : mid * POINT_TOL[m];
            lo = mid - tol;
            hi = mid + tol;
          }
          if (xv >= lo * (1 - RANGE_GRACE) && xv <= hi * (1 + RANGE_GRACE)) inside++;
        }
        inTargetPct = c ? round((100 * inside) / c) : null;
      }
      const easyUnder = p.easy && verdict === 'under';
      const zeroAt = easyUnder ? EASY_UNDER_ZERO_AT : ZERO_AT[m];
      const sAvg = 100 * Math.max(0, 1 - dev / zeroAt);
      sI = inTargetPct !== null && !easyUnder ? 0.6 * sAvg + 0.4 * inTargetPct : sAvg;
      intensity = {
        metric: m,
        actual: round(v, m === 'speed' ? 3 : 0),
        delta: round(delta, m === 'speed' ? 3 : 0),
        deltaPct: round(deltaPct, 3),
        inTargetPct,
        verdict,
      };
      if (actualStart !== undefined && actualEnd !== undefined) {
        intensity.actualStart = round(actualStart, m === 'speed' ? 3 : 0);
        intensity.actualEnd = round(actualEnd, m === 'speed' ? 3 : 0);
      }
      if (m === 'speed' && verdict !== 'on' && v > 0 && ref > 0) {
        const unitM = PACE_UNIT_M[paceUnitFor(sport, units, sport === 'swim' && units === 'imperial')];
        intensity.deltaPaceSec = round(unitM / ref - unitM / v);
      }
    }
  }

  // ── duration
  let duration: ExecutionStep['duration'] = null;
  let sD: number | null = null;
  if (p.plannedSec !== null) {
    const a = s.sec;
    const d = a - p.plannedSec;
    const tol = Math.max(10, 0.08 * p.plannedSec);
    duration = { basis: 'time', planned: p.plannedSec, actual: round(a), delta: round(d), verdict: Math.abs(d) <= tol ? 'on' : d > 0 ? 'long' : 'short' };
  } else if (p.plannedM !== null && s.distM !== null) {
    const a = s.distM;
    const d = a - p.plannedM;
    const tol = Math.max(20, 0.05 * p.plannedM);
    duration = { basis: 'distance', planned: p.plannedM, actual: round(a, 1), delta: round(d, 1), verdict: Math.abs(d) <= tol ? 'on' : d > 0 ? 'long' : 'short' };
  }
  if (duration) {
    const r = duration.actual / duration.planned;
    const lr = r > 0 ? Math.abs(Math.log(r)) : 3;
    sD = duration.verdict === 'on' ? 100 : 100 * Math.max(0, 1 - Math.max(0, lr - 0.05) / 0.6);
  }
  return { actual, intensity, duration, sI, sD };
}

// ───────────────────────────── text ─────────────────────────────

function signedPaceText(sec: number): string {
  const a = Math.abs(Math.round(sec));
  return a >= 60 ? fmtClock(a) : `${a} s`;
}

function intensityText(i: NonNullable<ExecutionStep['intensity']>, p: PlanStep, sport: Sport, units: Units): string {
  const harder = i.delta > 0;
  if (i.metric === 'speed') {
    const what = p.ramp ? 'the ramp' : p.point ? 'target' : harder ? 'the fast end of the range' : 'the slow end of the range';
    const ps = i.deltaPaceSec ?? 0;
    // A minute or more off (a walked recovery): the actual pace reads better than the difference.
    if (Math.abs(ps) >= 60 && i.actual > 0 && p.target) return `${paceText(i.actual, sport, units)}/${paceUnit(sport, units)} vs ${nativeText('speed', p.target.plannedLow, p.target.plannedHigh, sport, units)}`;
    return `${signedPaceText(ps)}/${paceUnit(sport, units)} ${harder ? 'faster' : 'slower'} than ${what}`;
  }
  const what = p.ramp ? 'the ramp' : p.point ? 'target' : harder ? 'the top of the range' : 'the bottom of the range';
  const unit = i.metric === 'power' ? 'W' : i.metric === 'hr' ? 'bpm' : sport === 'run' ? 'spm' : 'rpm';
  return `${Math.abs(Math.round(i.delta))} ${unit} ${harder ? 'above' : 'below'} ${what}`;
}

function durationText(d: NonNullable<ExecutionStep['duration']>, sport: Sport, units: Units): string {
  if (d.basis === 'time') return d.delta < 0 ? `ended ${fmtClock(-d.delta)} early` : `${fmtClock(d.delta)} long`;
  return `${fmtDistance(Math.abs(d.delta), sport, units)} ${d.delta < 0 ? 'short' : 'long'}`;
}

// ───────────────────────────── main ─────────────────────────────

function sessionScore(ratio: number): number {
  if (!(ratio > 0)) return 0;
  return Math.round(100 * Math.max(0, Math.min(1, 1 - Math.max(0, Math.abs(Math.log(ratio)) - 0.05) / 0.65)));
}

function totalsOf(input: ExecutionInput) {
  const w = input.workout;
  const a = input.activity;
  return {
    planned: { durationSec: w.plannedDurationSec ?? null, distanceM: w.plannedDistanceM ?? null, load: w.plannedLoad ?? null },
    actual: { durationSec: a.movingSec > 0 ? a.movingSec : a.durationSec, distanceM: a.distanceM ?? null, load: a.load },
  };
}

function sessionResult(input: ExecutionInput, note: string, plannedCount: number): ExecutionAnalysis {
  const c = input.compliance;
  const pct = Math.round(c.ratio * 100);
  const hasPlan = (input.workout.plannedLoad ?? 0) > 0 || (input.workout.plannedDurationSec ?? 0) > 0 || (input.workout.plannedDistanceM ?? 0) > 0;
  const word = c.metric === 'load' ? 'load' : c.metric === 'duration' ? 'time' : 'distance';
  const summary = hasPlan ? `Did ${pct}% of the planned ${word}` : 'No planned totals to compare';
  const state: ComplianceState = ['planned', 'missed', 'excused', 'unplanned'].includes(c.state) ? stateForRatio(c.ratio) : c.state;
  return {
    version: EXECUTION_VERSION,
    workoutId: input.workout.id,
    activityId: input.activity.id,
    method: 'session',
    confidence: 'low',
    note,
    score: hasPlan ? sessionScore(c.ratio) : 100,
    state,
    summary,
    counts: { planned: plannedCount, onTarget: 0, over: 0, under: 0, skipped: 0, extra: 0 },
    ...totalsOf(input),
    steps: [],
  };
}

/** Do the laps line up 1:1 with the plan? */
function lapsMatch(plan: PlanStep[], laps: readonly Lap[]): boolean {
  if (laps.length !== plan.length || plan.length < 2) return false;
  let comparable = 0;
  let ok = 0;
  plan.forEach((p, i) => {
    const l = laps[i];
    let r: number | null = null;
    if (p.plannedSec !== null) r = (l.movingSec ?? l.durationSec) / p.plannedSec;
    else if (p.plannedM !== null && l.distanceM !== undefined) r = l.distanceM / p.plannedM;
    if (r === null) return;
    comparable++;
    if (r > 0 && Math.abs(Math.log(r)) <= 0.3) ok++;
  });
  return comparable === 0 || ok / comparable >= 0.6;
}

/** Laps without accidental trailing presses (< 15 s). */
function cleanLaps(laps: readonly Lap[]): Lap[] {
  const out = [...laps].sort((a, b) => a.startSec - b.startSec);
  while (out.length > 1 && out[out.length - 1].durationSec < 15) out.pop();
  return out;
}

function pickBoundary(plan: PlanStep[], rec: Rec): ExecutionMetric | null {
  const weight = new Map<ExecutionMetric, number>();
  for (const p of plan) if (p.target) weight.set(p.target.metric, (weight.get(p.target.metric) ?? 0) + p.estSec);
  const ranked = [...weight.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
  for (const m of [...ranked, 'power', 'speed', 'hr'] as ExecutionMetric[]) if (coverage(rec.ch[m]) >= 0.5) return m;
  return null;
}

function refs(plan: PlanStep[], boundary: ExecutionMetric | null): { hardRef: number | null; easyRef: number | null } {
  let hardRef: number | null = null;
  let easyRef: number | null = null;
  for (const p of plan) {
    if (!p.target || p.target.metric !== boundary) continue;
    if (p.role === 'active') hardRef = hardRef === null ? p.target.low : Math.min(hardRef, p.target.low);
    else if (p.easy) easyRef = easyRef === null ? p.target.high : Math.max(easyRef, p.target.high);
  }
  if (hardRef !== null && easyRef !== null && easyRef >= hardRef) easyRef = null;
  return { hardRef, easyRef };
}

/** Plan-vs-actual analysis. Pure; see the module comment and docs/MOBILE_API.md §4. */
export function analyzeExecution(input: ExecutionInput): ExecutionAnalysis {
  const units = input.units ?? 'metric';
  const sport = input.workout.sport;
  const plan = buildPlan(input, units);
  if (!plan.length) return sessionResult(input, 'This plan has no steps, so it is compared on totals only', 0);
  if (plan.every((p) => p.measure === 'reps' || p.step.strength))
    return sessionResult(input, 'Strength sets are compared on totals only', plan.length);

  const rec = buildRec(input.streams);
  const laps = cleanLaps(input.laps ?? []);
  let segs: Seg[];
  let assign: Assignment;
  let method: 'laps' | 'streams';
  let note: string;
  let boundary: ExecutionMetric | null = null;
  let capMedium = false;

  if (lapsMatch(plan, laps)) {
    segs = lapSegments(laps, rec);
    if (segs.length !== plan.length) return sessionResult(input, 'Laps could not be read', plan.length);
    assign = { runs: plan.map((_, i) => ({ j0: i, j1: i + 1 })), extra: segs.map(() => false) };
    method = 'laps';
    note = `Laps match the plan's ${plan.length} steps`;
  } else {
    if (rec) boundary = pickBoundary(plan, rec);
    if (rec && boundary) {
      const { hardRef } = refs(plan, boundary);
      const dMin = Math.max(DELTA_MIN[boundary], boundary === 'speed' || boundary === 'power' ? (hardRef ?? 0) * 0.04 : 0);
      segs = segmentStreams(rec, boundary, laps, dMin);
      method = 'streams';
      const what = boundary === 'speed' ? 'pace' : boundary === 'hr' ? 'heart-rate' : boundary;
      note = laps.length > 1 ? `Laps don't line up with the plan's ${plan.length} steps; aligned on the ${what} stream` : `Aligned on the ${what} stream`;
    } else if (laps.length >= 2) {
      segs = lapSegments(laps, null);
      boundary = (['power', 'speed', 'hr'] as ExecutionMetric[]).find((m) => segs.some((s) => s.cnt[m] > 0)) ?? null;
      method = 'laps';
      capMedium = true;
      note = `No 1 Hz recording; aligned on ${laps.length} laps that don't map 1:1 to the plan`;
    } else {
      return sessionResult(input, rec ? 'Nothing in the recording to compare the targets with' : 'No laps or 1 Hz recording to align with the plan', plan.length);
    }
    const r = refs(plan, boundary);
    const secs = plan.map((p) => p.plannedSec ?? p.estSec).sort((a, b) => a - b);
    assign = alignDP(
      { plan, segs, boundary, hardRef: r.hardRef, easyRef: r.easyRef, medianSec: Math.max(60, secs[Math.floor(secs.length / 2)]) },
      { allowMulti: true },
    );
    absorbShortExtras(segs, assign, boundary);
    splitShared(plan, segs, assign, rec);
  }

  // ── measure every step
  const windowOf = (j0: number, j1: number): Window => {
    const seg = unionSeg(segs, j0, j1);
    return rec ? { a: seg.a, b: seg.b, seg } : { seg };
  };
  interface Row {
    out: ExecutionStep;
    p: PlanStep | null;
    w: number;
    s: number | null;
    sortKey: number;
    dir: number; // +1 over/long, −1 under/short
    bMean: number | null;
  }
  const rows: Row[] = [];
  plan.forEach((p, i) => {
    const run = assign.runs[i];
    const base: ExecutionStep = {
      plannedIndex: p.index,
      stepId: p.step.id,
      role: p.role,
      label: p.label,
      repeat: p.repeat,
      weight: 0,
      planned: {
        measure: p.measure,
        durationSec: p.plannedSec ?? round(p.estSec),
        distanceM: p.plannedM ?? (p.estM !== null ? round(p.estM) : null),
        target: p.target,
        targetText: p.targetText,
      },
      actual: null,
      intensity: null,
      duration: null,
      verdict: 'skipped',
      deviation: 'Not done',
      score: 0,
    };
    const w = ROLE_WEIGHT[p.role] * (p.plannedSec ?? p.estSec);
    if (!run) {
      rows.push({ out: base, p, w, s: 0, sortKey: Infinity, dir: -1, bMean: null });
      return;
    }
    const win = windowOf(run.j0, run.j1);
    const m = measure(p, win, rec, sport, units);
    base.actual = m.actual;
    base.intensity = m.intensity;
    base.duration = m.duration;
    const sI = m.sI;
    const sD = m.sD;
    const score = sI !== null && sD !== null ? 0.6 * sI + 0.4 * sD : (sI ?? sD ?? 100);
    const iv = m.intensity?.verdict ?? 'on';
    const dv = m.duration?.verdict ?? 'on';
    let verdict: ExecutionVerdict = 'on_target';
    const iDir = iv === 'over' ? 1 : iv === 'under' ? -1 : 0;
    const dDir = dv === 'long' ? 1 : dv === 'short' ? -1 : 0;
    if (iDir && dDir && iDir !== dDir) {
      const iPen = (100 - (sI ?? 100)) * 0.6;
      const dPen = (100 - (sD ?? 100)) * 0.4;
      verdict = (iPen >= dPen ? iDir : dDir) > 0 ? 'over' : 'under';
    } else if (iDir || dDir) verdict = (iDir || dDir) > 0 ? 'over' : 'under';
    base.verdict = verdict;
    const parts: string[] = [];
    if (m.intensity && iv !== 'on') parts.push(intensityText(m.intensity, p, sport, units));
    if (m.duration && dv !== 'on') parts.push(durationText(m.duration, sport, units));
    base.deviation = parts.length ? parts.join(' · ') : null;
    base.score = Math.round(score);
    const bm = boundary ? segMean(win.seg, boundary) : NaN;
    rows.push({ out: base, p, w, s: score, sortKey: win.seg.startSec, dir: verdict === 'over' ? 1 : verdict === 'under' ? -1 : 0, bMean: Number.isFinite(bm) ? bm : null });
  });
  // Skipped steps sort right after the previous step in plan order.
  for (let i = 0; i < rows.length; i++) if (rows[i].sortKey === Infinity) rows[i].sortKey = i > 0 ? rows[i - 1].sortKey + 0.001 : -1;

  // ── extras (consecutive extra segments form one block)
  const { easyRef, hardRef } = refs(plan, boundary);
  for (let j = 0; j < segs.length; j++) {
    if (!assign.extra[j]) continue;
    let k = j;
    while (k + 1 < segs.length && assign.extra[k + 1]) k++;
    const win = windowOf(j, k + 1);
    const m = measure(null, win, rec, sport, units);
    const bm = boundary ? segMean(win.seg, boundary) : NaN;
    const easy = Number.isFinite(bm) && ((easyRef !== null && bm <= easyRef * 1.02) || (easyRef === null && hardRef !== null && bm < hardRef * 0.85));
    const counts = win.seg.sec >= 180 && !easy && Number.isFinite(bm);
    rows.push({
      out: {
        plannedIndex: null,
        stepId: null,
        role: null,
        label: 'Extra',
        repeat: null,
        weight: 0,
        planned: null,
        actual: m.actual,
        intensity: null,
        duration: null,
        verdict: 'extra',
        deviation: `${fmtClock(win.seg.sec)} not in the plan`,
        score: null,
      },
      p: null,
      w: counts ? 0.3 * win.seg.sec : 0,
      s: counts ? 0 : null,
      sortKey: win.seg.startSec,
      dir: 1,
      bMean: Number.isFinite(bm) ? bm : null,
    });
    j = k;
  }
  rows.sort((a, b) => a.sortKey - b.sortKey);

  // ── confidence
  let confidence: ExecutionAnalysis['confidence'] = 'high';
  if (method === 'streams' || capMedium) {
    const planned = rows.filter((r) => r.p);
    const durDevs = planned
      .filter((r) => r.out.duration)
      .map((r) => Math.abs(Math.log(Math.max(1e-3, r.out.duration!.actual) / r.out.duration!.planned)))
      .sort((a, b) => a - b);
    const medDur = durDevs.length ? durDevs[Math.floor(durDevs.length / 2)] : 0;
    // Hard/easy contrast over the plan's (hard step, following easy step) pairs: a pair counts as
    // good only when both were found and the hard one really was harder.
    const byIndex = new Map(planned.map((r) => [r.p!.index, r] as const));
    let pairs = 0;
    let good = 0;
    for (let i = 0; i + 1 < plan.length; i++) {
      if (plan[i].role !== 'active' || !plan[i + 1].easy) continue;
      const a = byIndex.get(i)!;
      const b = byIndex.get(i + 1)!;
      if (boundary === null) continue;
      pairs++;
      if (a.bMean !== null && b.bMean !== null && a.out.actual && b.out.actual && a.bMean > b.bMean * 1.03) good++;
    }
    const contrast = pairs ? good / pairs : 1;
    const totalPlan = planned.reduce((s, r) => s + r.w, 0);
    const skipped = planned.filter((r) => !r.out.actual).reduce((s, r) => s + r.w, 0);
    const totalRec = segs.reduce((s, g) => s + g.sec, 0);
    const extraSec = rows.filter((r) => !r.p).reduce((s, r) => s + (r.out.actual?.durationSec ?? 0) * (r.w > 0 ? 1 : 0.5), 0);
    const c = 1 - 0.35 * Math.min(1, medDur / 0.7) - 0.35 * (1 - contrast) - 0.3 * Math.min(1, skipped / Math.max(1, totalPlan) + extraSec / Math.max(1, totalRec));
    confidence = c >= 0.75 ? 'high' : c >= 0.5 ? 'medium' : 'low';
    if (capMedium && confidence === 'high') confidence = 'medium';
    if (confidence === 'low') return sessionResult(input, "The recording doesn't line up with the plan's steps well enough to judge them one by one", plan.length);
  }

  // ── score, state
  const scored = rows.filter((r) => r.s !== null && r.w > 0);
  const W = scored.reduce((s, r) => s + r.w, 0);
  const score = W > 0 ? Math.round(scored.reduce((s, r) => s + r.w * r.s!, 0) / W) : 100;
  for (const r of rows) r.out.weight = W > 0 && r.s !== null ? round(r.w / W, 3) : 0;
  let state: ComplianceState = 'on_target';
  if (score < 80) {
    const dir = scored.reduce((s, r) => s + r.w * (100 - r.s!) * r.dir, 0);
    const long = dir > 0;
    state = score >= 50 ? (long ? 'partial_long' : 'partial_short') : long ? 'off_long' : 'off_short';
  }

  const steps = rows.map((r) => r.out);
  const counts = {
    planned: plan.length,
    onTarget: steps.filter((s) => s.verdict === 'on_target').length,
    over: steps.filter((s) => s.verdict === 'over').length,
    under: steps.filter((s) => s.verdict === 'under').length,
    skipped: steps.filter((s) => s.verdict === 'skipped').length,
    extra: steps.filter((s) => s.verdict === 'extra').length,
  };
  return {
    version: EXECUTION_VERSION,
    workoutId: input.workout.id,
    activityId: input.activity.id,
    method,
    confidence,
    note,
    score,
    state,
    summary: summarize(plan, rows, sport, units),
    counts,
    ...totalsOf(input),
    steps,
  };
}

/** Extra blocks shorter than this (s) are transitions (slowing down, a few seconds standing). */
const SHORT_EXTRA_SEC = 60;

/** Give short extra blocks to the neighbouring step whose level is closer (they are transitions). */
function absorbShortExtras(segs: Seg[], assign: Assignment, boundary: ExecutionMetric | null): void {
  const owner = new Array<number>(segs.length).fill(-1);
  assign.runs.forEach((r, i) => {
    if (r) for (let j = r.j0; j < r.j1; j++) owner[j] = i;
  });
  let j = 0;
  while (j < segs.length) {
    if (!assign.extra[j]) {
      j++;
      continue;
    }
    let k = j;
    while (k + 1 < segs.length && assign.extra[k + 1]) k++;
    const block = unionSeg(segs, j, k + 1);
    const prev = j > 0 ? owner[j - 1] : -1;
    const next = k + 1 < segs.length ? owner[k + 1] : -1;
    // Only between two steps: at the edges it is a late start / a stop after the end.
    if (block.sec < SHORT_EXTRA_SEC && prev >= 0 && next >= 0) {
      let to = prev >= 0 ? prev : next;
      if (prev >= 0 && next >= 0 && boundary) {
        const v = segMean(block, boundary);
        const pr = assign.runs[prev]!;
        const nr = assign.runs[next]!;
        const pv = segMean(unionSeg(segs, pr.j0, pr.j1), boundary);
        const nv = segMean(unionSeg(segs, nr.j0, nr.j1), boundary);
        if (Number.isFinite(v) && Number.isFinite(pv) && Number.isFinite(nv) && Math.abs(v - nv) < Math.abs(v - pv)) to = next;
      }
      const r = assign.runs[to]!;
      assign.runs[to] = to === prev ? { j0: r.j0, j1: k + 1 } : { j0: j, j1: r.j1 };
      for (let x = j; x <= k; x++) {
        assign.extra[x] = false;
        owner[x] = to;
      }
    }
    j = k + 1;
  }
}

/**
 * A skipped easy step next to a matched easy step (e.g. the last recovery and the cool-down, one
 * walk after the final rep): share that block — the earlier step gets its planned time, the later
 * one the rest.
 */
function splitShared(plan: PlanStep[], segs: Seg[], assign: Assignment, rec: Rec | null): void {
  if (!rec) return;
  // Only easy steps share a block: one hard block is never two reps.
  const compatible = (a: PlanStep, b: PlanStep) =>
    a.easy &&
    b.easy &&
    (!a.target || !b.target || (a.target.metric === b.target.metric && a.target.low <= b.target.high * 1.05 && b.target.low <= a.target.high * 1.05));
  // Nearest matched step in direction d with only skipped steps in between.
  const nearest = (i: number, d: 1 | -1): number => {
    for (let n = i + d; n >= 0 && n < plan.length; n += d) if (assign.runs[n]) return n;
    return -1;
  };
  for (let i = 0; i < plan.length; i++) {
    if (assign.runs[i]) continue;
    for (const n of [nearest(i, 1), nearest(i, -1)]) {
      const run = n >= 0 ? assign.runs[n] : null;
      if (!run || !compatible(plan[i], plan[n])) continue;
      const u = unionSeg(segs, run.j0, run.j1);
      if (u.sec < 60) continue;
      const earlier = Math.min(i, n);
      const firstSec = Math.min(plan[earlier].plannedSec ?? plan[earlier].estSec, u.sec - 30);
      const cut = u.a + Math.round(firstSec);
      const s1 = segOf(rec, u.a, cut);
      const s2 = segOf(rec, cut, u.b);
      // Replace the run's segments with the two halves.
      segs.splice(run.j0, run.j1 - run.j0, s1, s2);
      const delta = 2 - (run.j1 - run.j0);
      for (let k = 0; k < plan.length; k++) {
        const r = assign.runs[k];
        if (r && r.j0 > run.j0) assign.runs[k] = { j0: r.j0 + delta, j1: r.j1 + delta };
      }
      assign.extra.splice(run.j0, run.j1 - run.j0, false, false);
      assign.runs[earlier] = { j0: run.j0, j1: run.j0 + 1 };
      assign.runs[Math.max(i, n)] = { j0: run.j0 + 1, j1: run.j0 + 2 };
      break;
    }
  }
}

function rangeText(values: number[], unit: string): string {
  const v = values.map((x) => Math.abs(Math.round(x))).sort((a, b) => a - b);
  const lo = v[0];
  const hi = v[v.length - 1];
  const f = (x: number) => (unit.startsWith('s/') && x >= 60 ? fmtClock(x) : String(x));
  return lo === hi ? `${f(lo)} ${unit}` : `${f(lo)}–${f(hi)} ${unit}`;
}

function summarize(plan: PlanStep[], rows: { out: ExecutionStep; p: PlanStep | null; w: number }[], sport: Sport, units: Units): string {
  const phrases: string[] = [];
  const byPlan = rows.filter((r) => r.p);
  // The main set: the repeat block with the most planned active time.
  const activeInRepeat = byPlan.filter((r) => r.p!.role === 'active' && r.p!.inRepeat);
  const groupSec = new Map<string, number>();
  for (const r of activeInRepeat) groupSec.set(r.p!.flat.repeatIds[0], (groupSec.get(r.p!.flat.repeatIds[0]) ?? 0) + (r.p!.plannedSec ?? r.p!.estSec));
  const mainGroup = [...groupSec.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const reps = activeInRepeat.filter((r) => r.p!.flat.repeatIds[0] === mainGroup);
  const otherSkipped = byPlan.filter((r) => !r.out.actual && (r.p!.role === 'active' || r.p!.role === 'other') && !reps.includes(r)).length;
  const directionPhrase = (subject: string, list: typeof byPlan): string | null => {
    const withI = list.filter((r) => r.out.intensity && r.out.intensity.verdict !== 'on');
    const half = Math.max(1, Math.ceil(list.length / 2));
    const over = withI.filter((r) => r.out.intensity!.verdict === 'over');
    const under = withI.filter((r) => r.out.intensity!.verdict === 'under');
    const pick = over.length >= half ? { l: over, up: true } : under.length >= half ? { l: under, up: false } : null;
    if (!pick) return null;
    const m = pick.l[0].out.intensity!.metric;
    if (m === 'speed') return `${subject} ran ${rangeText(pick.l.map((r) => r.out.intensity!.deltaPaceSec ?? 0), `s/${paceUnit(sport, units)}`)} ${pick.up ? 'fast' : 'slow'}`;
    const unit = m === 'power' ? 'W' : m === 'hr' ? 'bpm' : sport === 'run' ? 'spm' : 'rpm';
    return `${subject} ran ${rangeText(pick.l.map((r) => r.out.intensity!.delta), unit)} ${pick.up ? 'high' : 'low'}`;
  };
  const durationPhrase = (subject: string, list: typeof byPlan): string | null => {
    const half = Math.max(1, Math.ceil(list.length / 2));
    const short = list.filter((r) => r.out.duration?.verdict === 'short').length;
    const long = list.filter((r) => r.out.duration?.verdict === 'long').length;
    if (short >= half) return `${subject} cut short`;
    if (long >= half) return `${subject} ran long`;
    return null;
  };
  if (reps.length >= 2) {
    const n = reps.length;
    const done = reps.filter((r) => r.out.actual);
    const hit = reps.filter((r) => r.out.verdict === 'on_target').length;
    phrases.push(done.length < n ? `Did ${done.length} of ${n} reps` : hit === n ? `Hit all ${n} reps` : `Hit ${hit} of ${n} reps`);
    if (done.length) {
      const d = directionPhrase('reps', done);
      const t = durationPhrase('reps', done);
      if (d && t) phrases.push(`${d} and ${t.endsWith('cut short') ? 'short' : 'long'}`);
      else if (d ?? t) phrases.push((d ?? t)!);
    }
  } else {
    for (const r of byPlan.filter((x) => x.p!.role === 'active' || x.p!.role === 'other')) {
      const name = r.p!.label.toLowerCase() === 'main set' ? 'main set' : r.p!.label;
      if (!r.out.actual) phrases.push(`skipped the ${name}`);
      else if (r.out.deviation) phrases.push(`${name} ${r.out.deviation}`);
    }
  }
  if (reps.length >= 2 && otherSkipped) phrases.push(`skipped ${otherSkipped} other ${otherSkipped === 1 ? 'step' : 'steps'}`);
  for (const role of ['warmup', 'cooldown'] as const) {
    const list = byPlan.filter((r) => r.p!.role === role);
    if (!list.length) continue;
    const name = role === 'warmup' ? 'warm-up' : 'cool-down';
    if (list.every((r) => !r.out.actual)) phrases.push(`skipped the ${name}`);
    else if (list.some((r) => r.out.duration?.verdict === 'short')) phrases.push(`cut the ${name} short`);
    else if (list.some((r) => r.out.intensity?.verdict === 'over')) phrases.push(`${name} too hard`);
    else if (list.some((r) => r.out.duration?.verdict === 'long')) phrases.push(`${name} ran long`);
  }
  const extras = rows.filter((r) => !r.p && r.w > 0);
  if (extras.length) phrases.push(`added ${fmtClock(extras.reduce((s, r) => s + (r.out.actual?.durationSec ?? 0), 0))} not in the plan`);
  const recs = byPlan.filter((r) => r.p!.role === 'recovery' && r.out.actual);
  if (recs.length >= 2) {
    const over = recs.filter((r) => r.out.intensity?.verdict === 'over').length;
    if (over >= Math.ceil(recs.length / 2)) phrases.push('recoveries too hard');
  }
  if (!phrases.length) return 'Executed as planned';
  const text = phrases.slice(0, 3).join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Compliance for chips when a structured analysis exists: the totals ratio stays, `state` and
 * `score` come from the execution analysis. A session-only analysis leaves compliance unchanged.
 */
export function complianceWithExecution(base: Compliance, exec: Pick<ExecutionAnalysis, 'method' | 'score' | 'state'> | null | undefined): Compliance {
  if (!exec || exec.method === 'session') return base;
  if (base.state === 'planned' || base.state === 'missed' || base.state === 'excused' || base.state === 'unplanned') return base;
  return { ...base, state: exec.state, score: exec.score };
}

