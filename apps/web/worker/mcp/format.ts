/**
 * Compact, agent-friendly projections of the API's domain objects. Units are always in the field
 * name (…Sec, …M, …Mps, …W, …Bpm, pace strings "m:ss/km"); dates are `YYYY-MM-DD` in the athlete's
 * time zone; absent values are omitted rather than null.
 */
import type {
  Activity,
  ActivityDetail,
  Compliance,
  Event,
  FitnessDay,
  PlannedWorkout,
  Sport,
  Template,
  WeekSummary,
  WellnessDay,
} from '@cadence/core/domain';
import { formatWorkoutText } from '@cadence/core/workout';

type Obj = Record<string, unknown>;

/** Drop undefined / null / NaN values (shallow). */
export function clean<T extends Obj>(o: T): Partial<T> {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export const round = (v: number | undefined | null, dp = 0): number | undefined =>
  v === undefined || v === null || !Number.isFinite(v) ? undefined : Math.round(v * 10 ** dp) / 10 ** dp;

/** 245 → "4:05". */
export function clock(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** Pace per distance unit for a speed in m/s: per km for foot sports, per 100 m swim, per 500 m row. */
export function paceOf(mps: number | undefined, sport: Sport): string | undefined {
  if (!mps || !(mps > 0)) return undefined;
  if (sport === 'swim') return `${clock(100 / mps)}/100m`;
  if (sport === 'row') return `${clock(500 / mps)}/500m`;
  if (sport === 'run' || sport === 'walk' || sport === 'hike') return `${clock(1000 / mps)}/km`;
  return undefined;
}

/** "m:ss" (or "h:mm:ss") → seconds; undefined when malformed. */
export function parseClock(s: string): number | undefined {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)\s*$/.exec(s);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export const compliance = (c: Compliance | undefined) =>
  c
    ? clean({
        state: c.state,
        metric: c.metric,
        actualVsPlannedPct: c.state === 'unplanned' || c.state === 'planned' ? undefined : round(c.ratio * 100),
        // execution adherence 0–100 (execution analysis feature), when a structured analysis exists
        executionScore: round((c as Compliance & { score?: number }).score),
      })
    : undefined;

/** HH:MM local start of an activity. */
export function localStart(a: Pick<Activity, 'startedAt' | 'utcOffsetMin'>): string | undefined {
  const t = Date.parse(a.startedAt);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t + a.utcOffsetMin * 60_000).toISOString().slice(11, 16);
}

export function structureText(w: Pick<PlannedWorkout, 'structure' | 'sport'>): string | undefined {
  if (!w.structure?.steps.length) return undefined;
  try {
    return formatWorkoutText(w.structure, w.sport);
  } catch {
    return undefined;
  }
}

export function workoutSummary(w: PlannedWorkout) {
  return clean({
    id: w.id,
    date: w.date,
    startTime: w.startTime,
    sport: w.sport,
    subSport: w.subSport,
    title: w.title,
    status: w.status,
    skipReason: w.skipReason,
    isKey: w.isKey || undefined,
    intensity: w.intensity,
    plannedDurationSec: round(w.plannedDurationSec),
    plannedDistanceM: round(w.plannedDistanceM),
    plannedLoad: round(w.plannedLoad),
    structured: !!w.structure?.steps.length,
    compliance: compliance(w.compliance),
    pairedActivityId: w.pairedActivityId,
    garminSync: w.garmin.syncState === 'none' ? undefined : w.garmin.syncState,
  });
}

export function workoutDetail(w: PlannedWorkout, opts: { structureJson?: boolean } = {}) {
  return clean({
    ...workoutSummary(w),
    description: w.description,
    preNote: w.preNote,
    plannedIntensityFactor: round(w.plannedIntensityFactor, 2),
    tags: w.tags.length ? w.tags : undefined,
    environment: w.environment === 'any' ? undefined : w.environment,
    structureText: structureText(w),
    structure: opts.structureJson ? w.structure : undefined,
    templateId: w.templateId,
    seriesId: w.seriesId,
    eventId: w.eventId,
    garmin: w.garmin.syncState === 'none' ? undefined : clean({ ...w.garmin }),
    updatedAt: w.updatedAt,
  });
}

export function activitySummary(a: Activity) {
  const speed = a.avgSpeedMps;
  return clean({
    id: a.id,
    date: a.localDate,
    startTime: localStart(a),
    sport: a.sport,
    subSport: a.subSport,
    title: a.title,
    durationSec: round(a.durationSec),
    movingSec: round(a.movingSec),
    distanceM: round(a.distanceM),
    elevationGainM: round(a.elevationGainM),
    load: round(a.load),
    loadSource: a.loadSource,
    intensityFactor: round(a.intensityFactor, 2),
    intensity: a.intensity,
    isKey: a.isKey || undefined,
    avgHrBpm: round(a.avgHr),
    maxHrBpm: round(a.maxHr),
    avgPowerW: round(a.avgPower),
    weightedPowerW: round(a.weightedPower),
    avgSpeedMps: round(speed, 3),
    avgPace: paceOf(speed, a.sport),
    gradeAdjustedPace: a.sport === 'run' ? paceOf(a.adjustedSpeedMps, a.sport) : undefined,
    avgCadence: round(a.avgCadence),
    rpe: a.rpe,
    feel: a.feel,
    postNote: a.postNote,
    pairedWorkoutId: a.pairedWorkoutId,
    compliance: compliance(a.compliance),
  });
}

export function activityDetail(d: ActivityDetail, opts: { laps: boolean; zones: boolean; peaks: boolean }) {
  const extra = clean({
    calories: round(d.calories),
    workKj: round(d.workKj),
    variabilityIndex: round(d.variability, 2),
    efficiencyFactor: round(d.efficiency, 2),
    decouplingPct: round(d.decouplingPct, 1),
    aerobicTrainingEffect: round(d.aerobicEffect, 1),
    anaerobicTrainingEffect: round(d.anaerobicEffect, 1),
    poolLengthM: d.poolLengthM,
    avgSwolf: round(d.avgSwolf),
    totalSets: d.totalSets,
    totalReps: d.totalReps,
    volumeKg: round(d.volumeKg),
    locationName: d.locationName,
    tags: d.tags.length ? d.tags : undefined,
  });
  const laps = opts.laps
    ? d.laps.map((l) =>
        clean({
          lap: l.index + 1,
          startSec: round(l.startSec),
          durationSec: round(l.durationSec),
          distanceM: round(l.distanceM),
          avgHrBpm: round(l.avgHr),
          maxHrBpm: round(l.maxHr),
          avgPowerW: round(l.avgPower),
          weightedPowerW: round(l.weightedPower),
          avgSpeedMps: round(l.avgSpeedMps, 3),
          avgPace: paceOf(l.avgSpeedMps, d.sport),
          avgCadence: round(l.avgCadence),
          elevationGainM: round(l.elevationGainM),
          isRest: l.isRest || undefined,
        }),
      )
    : undefined;
  const zoneRows = (rows: ActivityDetail['zones']['hr'], unit: string) =>
    rows?.map((z) => clean({ zone: z.zone, name: z.name, [`low${unit}`]: round(z.low, unit === 'Mps' ? 3 : 0), [`high${unit}`]: round(z.high, unit === 'Mps' ? 3 : 0), seconds: round(z.seconds) }));
  const zones = opts.zones
    ? clean({ hr: zoneRows(d.zones.hr, 'Bpm'), power: zoneRows(d.zones.power, 'W'), pace: zoneRows(d.zones.pace, 'Mps') })
    : undefined;
  const peaks = opts.peaks
    ? clean({
        powerW: d.peaks.power?.map((p) => ({ durationSec: p.durationSec, watts: round(p.value) })),
        hrBpm: d.peaks.hr?.map((p) => ({ durationSec: p.durationSec, bpm: round(p.value) })),
        bestEfforts: d.peaks.efforts?.map((e) => ({ distanceM: e.distanceM, timeSec: round(e.timeSec), time: clock(e.timeSec) })),
      })
    : undefined;
  return clean({
    ...activitySummary(d),
    ...extra,
    thresholdsUsed: thresholdSnapshot(d.thresholdsUsed),
    plannedWorkout: d.plannedWorkout ? workoutDetail(d.plannedWorkout) : undefined,
    laps,
    zones,
    peaks,
    strengthSets: d.strengthSets?.filter((s) => !s.isRest).map((s) => clean({ exercise: s.exercise, reps: s.reps, weightKg: s.weightKg, durationSec: s.durationSec })),
    previousSimilar: d.previousSimilar ? activitySummary(d.previousSimilar) : undefined,
  });
}

export function thresholdSnapshot(t: ActivityDetail['thresholdsUsed']) {
  return clean({
    ftpW: t.ftp,
    runThresholdMps: round(t.runThresholdMps, 3),
    runThresholdPace: paceOf(t.runThresholdMps, 'run'),
    swimCssMps: round(t.swimCssMps, 3),
    swimCssPace: paceOf(t.swimCssMps, 'swim'),
    rowThresholdW: t.rowThresholdW,
    lthrBpm: t.lthr,
    hrMaxBpm: t.hrMax,
    hrRestBpm: t.hrRest,
    weightKg: t.weightKg,
  });
}

export const eventOut = (e: Event) => clean({ ...e });

export function fitnessDay(f: FitnessDay) {
  return clean({
    date: f.date,
    load: round(f.load),
    plannedLoad: f.plannedLoad ? round(f.plannedLoad) : undefined,
    fitness: round(f.fitness, 1),
    fatigue: round(f.fatigue, 1),
    form: round(f.form, 1),
    formPct: round(f.formPct, 0),
    formZone: f.formZone,
    ramp: round(f.ramp, 1),
    projected: f.projected || undefined,
  });
}

export function weekSummary(w: WeekSummary) {
  return clean({
    isoWeek: w.isoWeek,
    startDate: w.startDate,
    endDate: w.endDate,
    plannedSec: round(w.plannedSec),
    doneSec: round(w.doneSec),
    plannedLoad: round(w.plannedLoad),
    doneLoad: round(w.doneLoad),
    plannedDistanceM: round(w.plannedDistanceM),
    doneDistanceM: round(w.doneDistanceM),
    elevationGainM: round(w.elevationGainM),
    projectedSec: w.isProjected ? round(w.projectedSec) : undefined,
    projectedLoad: w.isProjected ? round(w.projectedLoad) : undefined,
    targetHours: w.targetHours,
    targetLoad: w.targetLoad,
    compliancePct: round(w.compliancePct),
    keyPlanned: w.keyPlanned,
    keyDone: w.keyDone,
    easyModerateHardSec: [round(w.intensitySec.easy), round(w.intensitySec.moderate), round(w.intensitySec.hard)],
    fitnessEnd: round(w.fitness, 1),
    fatigueEnd: round(w.fatigue, 1),
    formEnd: round(w.form, 1),
    formZone: w.formZone,
    fitnessDelta: round(w.fitnessDelta, 1),
    weekOverWeekLoadPct: w.wowLoad === null ? undefined : round(w.wowLoad * 100),
    isProjected: w.isProjected || undefined,
    bySport: w.bySport
      .filter((s) => s.plannedCount || s.doneCount)
      .map((s) =>
        clean({
          sport: s.sport,
          plannedSec: round(s.plannedSec),
          doneSec: round(s.doneSec),
          plannedLoad: round(s.plannedLoad),
          doneLoad: round(s.doneLoad),
          plannedDistanceM: round(s.plannedDistanceM) || undefined,
          doneDistanceM: round(s.doneDistanceM) || undefined,
          plannedCount: s.plannedCount,
          doneCount: s.doneCount,
        }),
      ),
  });
}

export function wellnessDay(w: WellnessDay) {
  return clean({
    date: w.date,
    hrvMs: round(w.hrvMs),
    hrvStatus: w.hrvStatus,
    restingHrBpm: round(w.restingHr),
    sleepSec: round(w.sleepSec),
    sleepScore: round(w.sleepScore),
    weightKg: round(w.weightKg, 1),
    bodyBattery: round(w.bodyBattery),
    stress: round(w.stress),
    readiness: round(w.readiness),
    vo2max: round(w.vo2max, 1),
    feel: w.feel,
    soreness: w.soreness,
    note: w.note,
  });
}

export function templateSummary(t: Template) {
  return clean({
    id: t.id,
    sport: t.sport,
    subSport: t.subSport,
    title: t.title,
    intensity: t.intensity,
    plannedDurationSec: round(t.plannedDurationSec),
    plannedDistanceM: round(t.plannedDistanceM),
    plannedLoad: round(t.plannedLoad),
    folder: t.folder,
    tags: t.tags.length ? t.tags : undefined,
    usageCount: t.usageCount || undefined,
    structureText: structureText(t),
  });
}
