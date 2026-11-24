/**
 * MCP tools: what an AI coach / assistant can read and change. Every tool goes through the JSON API
 * in-process (see api.ts), so behaviour is identical to the web app. Inputs are zod schemas
 * (exported to JSON Schema for `tools/list`); outputs are compact JSON (see format.ts).
 */
import { z } from 'zod';
import {
  DAY_MARKER_TYPES,
  INTENSITY_CLASSES,
  SKIP_REASONS,
  SPORTS,
  STREAM_CHANNELS,
  SUB_SPORTS,
  THRESHOLD_KINDS,
  type Activity,
  type ActivityDetail,
  type ActivityStreams,
  type CalendarResponse,
  type DayMarker,
  type DayNote,
  type Event,
  type FitnessDay,
  type PlannedWorkout,
  type PlannedWorkoutDetail,
  type Settings,
  type Sport,
  type Template,
  type Threshold,
  type ThresholdKind,
  type ThresholdSnapshot,
  type WeekSummary,
  type WeightSummary,
  type WellnessDay,
} from '@cadence/core/domain';
import { addDays, diffDays } from '@cadence/core/time';
import type { ApiClient } from './api';
import { executionAnalysis } from './execution';
import {
  activityDetail,
  activitySummary,
  clean,
  eventOut,
  fitnessDay,
  paceOf,
  parseClock,
  round,
  templateSummary,
  thresholdSnapshot,
  weekSummary,
  wellnessDay,
  workoutDetail,
  workoutSummary,
} from './format';

export interface ToolContext {
  api: ApiClient;
}

/** A failure the agent should see as a tool error (isError: true) rather than a protocol error. */
export class ToolError extends Error {}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  annotations: ToolAnnotations;
  run(args: unknown, ctx: ToolContext): Promise<unknown>;
}

function tool<S extends z.ZodObject>(def: {
  name: string;
  title: string;
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run: (args: z.output<S>, ctx: ToolContext) => Promise<unknown>;
}): ToolDef {
  return { ...def, run: (args, ctx) => def.run(args as z.output<S>, ctx) };
}

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = (o: Partial<ToolAnnotations> = {}): ToolAnnotations => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false, ...o });

// ───────────────────────────── shared input schemas ─────────────────────────────

const date = (what = 'Date') => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').describe(`${what} (YYYY-MM-DD, athlete's local calendar date)`);
const id = (what: string) => z.string().min(1).max(100).describe(what);
const sport = z.enum(SPORTS).describe('Sport');
const subSport = z.enum(SUB_SPORTS).describe('Sub-sport: bike road|indoor|virtual|gravel|mtb, run road_run|trail|treadmill|track, swim pool|open_water, row erg|on_water, strength gym|bodyweight|mobility|hiit');
const intensity = z.enum(INTENSITY_CLASSES).describe('Intensity class (recovery < endurance < tempo < threshold < high; race)');
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'Use HH:MM (24 h)').describe('Local start time HH:MM (24 h)');
/** Raw structure: only its outline is described here (the full schema is ~17 KB); the API validates it. */
const structureJson = z.object({
  steps: z.array(z.object({ kind: z.enum(['step', 'repeat']) }).catchall(z.json())).min(1),
  poolLengthM: z.number().positive().optional(),
});
const scope = z.enum(['this', 'following']).default('this').describe("'this' = only this workout; 'following' = this and every later workout of the same repeating series");

/** Days between two dates inclusive; throws a ToolError when the range is reversed or too long. */
function span(from: string, to: string, max: number): number {
  if (to < from) throw new ToolError('`to` must not be before `from`');
  const n = diffDays(from, to) + 1;
  if (n > max) throw new ToolError(`Range too long: ${n} days (max ${max}). Split it into smaller ranges.`);
  return n;
}

const STRUCTURE_SYNTAX = `Workout text syntax (one step per line; repeats indent their children by 2 spaces):
- Step: "- [role] <duration|distance> [target] [// cue]". Roles: wu (warm-up), cd (cool-down), r (recovery), rest. Duration 1h15m | 8m | 90s | 8:00; distance 400m | 2km | 10k | 1mi | 100y; "lap" = until lap button.
- Repeat block: "Nx" on its own line followed by indented steps; or inline "6x 3m 110% / 3m 50%", "5x1000m r2m".
- Targets: bare % = %FTP on bike/row, % of threshold pace on run/swim; 95%ftp, 85%hr, 250w, 240-260w, 150-160bpm, z2 (power zone on bike, HR zone elsewhere; "z2 pace" on run), 4:30/km, 4:20-4:30/km, 1:45/100m, css+3s, thr-5s, rpe 7, ramp 50-75%, easy|tempo|threshold|hard, 90rpm.
- Swim extras: "pool 25m" line, strokes free|back|breast|fly|im|kick|drill, "+pull +paddles +fins", "on 1:50" send-off, "r 20s" rest.
- Strength lines: "Back squat 4x6 @80kg rpe 8 r 2m" (exercise SETSxREPS [@weight] [rpe] [rest]).
- Meta lines: "title: Text", "@key" (key session), "#tag", "intensity: tempo", "// comment".
Examples:
bike: "- wu 15m 55-65%\\n3x\\n  - 10m 95-100%\\n  - r 5m 55%\\n- cd 10m 50%"
run: "- wu 2km easy\\n6x\\n  - 800m 4:05/km\\n  - r 400m easy\\n- cd 10m easy"
swim: "pool 25m\\n- wu 400m choice\\n8x\\n  - 100m css on 1:50\\n- cd 200m easy"`;

// ───────────────────────────── helpers ─────────────────────────────

async function today(api: ApiClient): Promise<string> {
  return (await api.get<{ date: string }>('/zones')).date;
}

interface ParseResponse {
  structure: PlannedWorkout['structure'];
  title?: string;
  issues: { line: number; col: number; message: string; severity: 'error' | 'warning' | 'info' }[];
  meta: { isKey?: boolean; tags: string[]; intensity?: (typeof INTENSITY_CLASSES)[number] };
}

/** Parse workout text with the app's parser; errors become a ToolError listing every issue. */
async function parseText(api: ApiClient, sport: Sport, text: string, onDate?: string) {
  const r = await api.send<ParseResponse>('POST', '/workouts/parse', { sport, text, ...(onDate ? { date: onDate } : {}) });
  const errors = r.issues.filter((i) => i.severity === 'error');
  if (errors.length || !r.structure?.steps.length) {
    const list = (errors.length ? errors : r.issues).map((i) => `line ${i.line}, col ${i.col}: ${i.message}`).join('; ');
    throw new ToolError(`Could not parse the workout text${list ? `: ${list}` : ' (no steps found)'}. Fix the text and retry.`);
  }
  return { ...r, warnings: r.issues.filter((i) => i.severity === 'warning').map((i) => `line ${i.line}: ${i.message}`) };
}

function zoneTable(t: ZoneTable | null, sport: Sport) {
  if (!t) return undefined;
  const unit = t.unit === 'W' ? 'W' : t.unit === 'bpm' ? 'Bpm' : 'Mps';
  return clean({
    model: t.model,
    [`threshold${unit}`]: round(t.threshold, unit === 'Mps' ? 3 : 0),
    thresholdPace: unit === 'Mps' ? paceOf(t.threshold, sport) : undefined,
    defaulted: t.defaulted || undefined,
    zones: t.zones.map((z) => {
      const lo = z.low ?? undefined;
      const hi = z.high ?? undefined;
      return clean({
        zone: z.zone,
        name: z.name,
        [`low${unit}`]: lo,
        [`high${unit}`]: hi,
        // speeds: low = slower bound, so the pace range reads slow → fast
        paceRange: unit === 'Mps' ? `${lo ? paceOf(lo, sport) : 'slower'} → ${hi ? paceOf(hi, sport) : 'faster'}` : undefined,
      });
    }),
  });
}

interface ZoneTable {
  model: string;
  unit: 'W' | 'bpm' | 'mps';
  threshold: number;
  defaulted: boolean;
  zones: { zone: number; name: string; low: number | null; high: number | null }[];
}
interface ZonesResponse {
  date: string;
  sports: Record<'bike' | 'run' | 'swim' | 'row' | 'other', { thresholds: ThresholdSnapshot; defaulted: string[]; hr: ZoneTable | null; power: ZoneTable | null; pace: ZoneTable | null }>;
}

function zonesOut(z: ZonesResponse) {
  const out: Record<string, unknown> = {};
  for (const s of ['bike', 'run', 'swim', 'row'] as const) {
    const v = z.sports[s];
    out[s] = clean({
      thresholds: thresholdSnapshot(v.thresholds),
      assumedDefaults: v.defaulted.length ? v.defaulted : undefined,
      hrZones: zoneTable(v.hr, s),
      powerZones: zoneTable(v.power, s),
      paceZones: zoneTable(v.pace, s),
    });
  }
  return out;
}

interface GarminStatusResponse {
  connected: boolean;
  state: string;
  lastSyncAt?: string;
  lastError?: string;
  capabilities: { read: boolean; write: boolean };
  demo: boolean;
}

const garminOut = (g: GarminStatusResponse) =>
  clean({
    connected: g.connected,
    state: g.state,
    lastSyncAt: g.lastSyncAt,
    lastError: g.lastError,
    canReadActivities: g.capabilities.read,
    canPushWorkouts: g.capabilities.write,
    demo: g.demo || undefined,
  });

/** Compact weight block: headline numbers + goal (no daily series). */
const weightHeadline = (w: WeightSummary) =>
  w.latest
    ? clean({
        latestKg: w.latest.weightKg,
        latestDate: w.latest.date,
        trendKg: w.trendKg,
        change7dKg: w.change7dKg,
        change28dKg: w.change28dKg,
        ratePerWeekKg: w.ratePerWeekKg,
        goal: w.goal ? clean({ ...w.goal }) : undefined,
      })
    : clean({ note: 'No weight logged yet', goal: w.goal ? clean({ ...w.goal }) : undefined });

// ───────────────────────────── tools ─────────────────────────────

export const TOOLS: ToolDef[] = [
  // ── context ──
  tool({
    name: 'get_athlete_context',
    title: 'Athlete context',
    description:
      "Start here. Returns the athlete's profile (name, sex, birth year, units preference, IANA timezone, week start), today's date in their timezone, current thresholds per sport (FTP W, run threshold pace, swim CSS, LTHR/max/resting HR bpm, weight kg) with the HR/power/pace zone tables derived from them, upcoming events (races) for the next 12 months, current Fitness/Fatigue/Form (42-day / 7-day load averages; form = fitness − fatigue), this week's planned vs done totals, body weight (latest reading, smoothed trend, kg/week rate and goal progress), and Garmin connection + last sync time. All dates are YYYY-MM-DD in the athlete's timezone; durations in seconds; distances in metres; speeds m/s with pace strings.",
    input: z.object({}),
    annotations: READ,
    run: async (_a, { api }) => {
      const [settings, zones, todayData, garmin, weight] = await Promise.all([
        api.get<Settings>('/settings'),
        api.get<ZonesResponse>('/zones'),
        api.get<{ date: string; fitness: FitnessDay; week: WeekSummary }>('/today'),
        api.get<GarminStatusResponse>('/garmin/status'),
        api.get<WeightSummary>('/weight'),
      ]);
      const events = await api.get<Event[]>('/events', { from: zones.date, to: addDays(zones.date, 365) });
      return {
        today: zones.date,
        profile: clean({
          name: settings.name || undefined,
          sex: settings.sex,
          birthYear: settings.birthYear,
          unitsPreference: settings.units,
          timezone: settings.timezone,
          weekStart: settings.weekStart,
        }),
        note: 'Tool inputs and outputs are always metric (seconds, metres, m/s, W, bpm, kg) regardless of unitsPreference.',
        fitnessToday: fitnessDay(todayData.fitness),
        thisWeek: weekSummary(todayData.week),
        bodyWeight: weightHeadline(weight),
        sports: zonesOut(zones),
        upcomingEvents: events.map((e) => ({ ...eventOut(e), daysUntil: diffDays(zones.date, e.date) })),
        garmin: garminOut(garmin),
      };
    },
  }),

  // ── calendar ──
  tool({
    name: 'get_calendar',
    title: 'Calendar',
    description:
      'Planned workouts, completed activities, events, phases, day markers (sick/travel/rest…), day notes and per-ISO-week summaries for a date range (max 92 days). Only days with something on them are listed. Workouts carry `compliance` (actualVsPlannedPct of load/duration/distance and a state: on_target 80–120 %, partial_short, partial_long, off_short, off_long, missed, excused, planned). Use get_workout / get_activity for details.',
    input: z.object({ from: date('First day'), to: date('Last day (inclusive)') }),
    annotations: READ,
    run: async ({ from, to }, { api }) => {
      span(from, to, 92);
      const cal = await api.get<CalendarResponse>('/calendar', { from, to });
      const inRange = (d: string) => d >= from && d <= to;
      const days = new Map<string, { date: string; workouts: unknown[]; activities: unknown[]; note?: string; markers?: unknown[] }>();
      const day = (d: string) => {
        let x = days.get(d);
        if (!x) days.set(d, (x = { date: d, workouts: [], activities: [] }));
        return x;
      };
      for (const w of cal.workouts) if (inRange(w.date)) day(w.date).workouts.push(workoutSummary(w));
      for (const a of cal.activities) if (inRange(a.localDate)) day(a.localDate).activities.push(activitySummary(a));
      for (const n of cal.dayNotes as DayNote[]) if (inRange(n.date)) day(n.date).note = n.body;
      for (const m of cal.markers as DayMarker[]) {
        for (let d = m.date < from ? from : m.date; d <= (m.endDate ?? m.date) && d <= to; d = addDays(d, 1)) {
          (day(d).markers ??= []).push(clean({ type: m.type, label: m.label }));
        }
      }
      const list = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => clean({ ...d, workouts: d.workouts.length ? d.workouts : undefined, activities: d.activities.length ? d.activities : undefined }));
      return {
        from,
        to,
        today: cal.today,
        days: list,
        events: cal.events.filter((e) => inRange(e.date)).map(eventOut),
        phases: cal.phases.map((p) => clean({ ...p })),
        weeks: cal.weeks.filter((w) => w.endDate >= from && w.startDate <= to).map(weekSummary),
      };
    },
  }),
  tool({
    name: 'get_today',
    title: 'Today',
    description:
      "Today's cockpit: planned workouts and completed activities today, readiness (heuristic from HRV / resting HR / sleep / form, not medical), today's wellness, Fitness/Fatigue/Form, this week's totals, the next event and next A-race with days until, today's day note and active day markers.",
    input: z.object({}),
    annotations: READ,
    run: async (_a, { api }) => {
      const t = await api.get<{
        date: string;
        workouts: PlannedWorkout[];
        activities: Activity[];
        wellness: { today: WellnessDay | null; readiness: unknown; hrv: unknown; restingHr: unknown; sleep: unknown };
        fitness: FitnessDay;
        week: WeekSummary;
        nextEvent: { event: Event; daysUntil: number } | null;
        nextAEvent: { event: Event; daysUntil: number } | null;
        dayNote: DayNote | null;
        markers: DayMarker[];
      }>('/today');
      return clean({
        date: t.date,
        workouts: t.workouts.map((w) => workoutDetail(w)),
        activities: t.activities.map(activitySummary),
        readiness: t.wellness.readiness,
        wellnessToday: t.wellness.today ? wellnessDay(t.wellness.today) : undefined,
        hrv: t.wellness.hrv,
        restingHr: t.wellness.restingHr,
        sleepHours: t.wellness.sleep,
        fitness: fitnessDay(t.fitness),
        thisWeek: weekSummary(t.week),
        nextEvent: t.nextEvent ? { ...eventOut(t.nextEvent.event), daysUntil: t.nextEvent.daysUntil } : undefined,
        nextAEvent: t.nextAEvent ? { ...eventOut(t.nextAEvent.event), daysUntil: t.nextAEvent.daysUntil } : undefined,
        dayNote: t.dayNote?.body,
        markers: t.markers.length ? t.markers.map((m) => clean({ ...m })) : undefined,
      });
    },
  }),

  // ── workouts ──
  tool({
    name: 'get_workout',
    title: 'Get planned workout',
    description:
      'One planned workout: title, date, sport, planned duration (s) / distance (m) / load, intensity, description and pre-workout note, its structure as workout text (same syntax create_workout accepts), compliance against the paired activity, the step-by-step execution analysis (plan vs actual, score 0–100) when it has been done, and Garmin sync state. Set includeStructureJson for the raw structured steps.',
    input: z.object({ id: id('Workout id (wk_…)'), includeStructureJson: z.boolean().default(false).describe('Also return the raw structure JSON') }),
    annotations: READ,
    run: async ({ id, includeStructureJson }, { api }) => {
      const w = await api.get<PlannedWorkoutDetail>(`/workouts/${encodeURIComponent(id)}`);
      return clean({ ...workoutDetail(w, { structureJson: includeStructureJson }), execution: executionAnalysis(w, w.sport) });
    },
  }),
  tool({
    name: 'create_workout',
    title: 'Create planned workout',
    description: `Add a planned workout to the calendar. Give EITHER \`text\` (structured steps in the app's workout text syntax — preferred), OR \`structure\` (raw JSON as returned by get_workout includeStructureJson), OR \`templateId\` (from list_templates), OR neither for an unstructured session with plannedDurationSec / plannedDistanceM. Planned duration, distance, load and (unless given) intensity and title are derived from the steps and the athlete's thresholds on that date. Returns the created workout with its derived totals and any parser warnings.\n\n${STRUCTURE_SYNTAX}`,
    input: z.object({
      date: date('Day to schedule it on'),
      sport,
      subSport: subSport.optional(),
      title: z.string().max(200).optional().describe('Title; derived from the structure when omitted'),
      startTime: hhmm.optional(),
      text: z.string().min(1).max(20_000).optional().describe('Workout steps in the text syntax described above'),
      structure: structureJson.optional().describe('Raw structure JSON ({ steps: [...] }, as returned by get_workout includeStructureJson) — alternative to text'),
      templateId: z.string().optional().describe('Schedule a library template (list_templates) instead of giving steps'),
      plannedDurationSec: z.number().int().positive().max(86_400).optional().describe('Unstructured sessions only: planned duration in seconds'),
      plannedDistanceM: z.number().positive().max(1_000_000).optional().describe('Unstructured sessions only: planned distance in metres'),
      intensity: intensity.optional(),
      isKey: z.boolean().optional().describe('Mark as a key session'),
      description: z.string().max(10_000).optional().describe('Purpose / coaching notes (markdown)'),
      preNote: z.string().max(5_000).optional().describe('Short note shown before the session'),
      tags: z.array(z.string().max(40)).max(20).optional(),
    }),
    annotations: WRITE(),
    run: async (a, { api }) => {
      const given = [a.text, a.structure, a.templateId].filter((x) => x !== undefined).length;
      if (given > 1) throw new ToolError('Give only one of text, structure or templateId');
      if (a.templateId) {
        const r = await api.send<{ workouts: PlannedWorkout[] }>('POST', `/templates/${encodeURIComponent(a.templateId)}/schedule`, {
          date: a.date,
          ...(a.startTime ? { startTime: a.startTime } : {}),
        });
        let w = r.workouts[0];
        const patch = clean({ title: a.title, intensity: a.intensity, isKey: a.isKey, description: a.description, preNote: a.preNote, tags: a.tags, subSport: a.subSport });
        if (Object.keys(patch).length) w = await api.send<PlannedWorkout>('PATCH', `/workouts/${w.id}`, patch);
        return { created: workoutDetail(w) };
      }
      let structure: unknown = a.structure;
      let warnings: string[] | undefined;
      let meta: ParseResponse['meta'] | undefined;
      let parsedTitle: string | undefined;
      if (a.text) {
        const p = await parseText(api, a.sport, a.text, a.date);
        structure = p.structure;
        meta = p.meta;
        parsedTitle = p.title;
        warnings = p.warnings.length ? p.warnings : undefined;
      }
      const tags = [...new Set([...(a.tags ?? []), ...(meta?.tags ?? [])])];
      const body = clean({
        date: a.date,
        sport: a.sport,
        subSport: a.subSport,
        title: a.title ?? parsedTitle,
        startTime: a.startTime,
        structure,
        plannedDurationSec: structure ? undefined : a.plannedDurationSec,
        plannedDistanceM: structure ? undefined : a.plannedDistanceM,
        intensity: a.intensity ?? meta?.intensity,
        isKey: a.isKey ?? meta?.isKey,
        description: a.description,
        preNote: a.preNote,
        tags: tags.length ? tags : undefined,
      });
      const w = await api.send<PlannedWorkout>('POST', '/workouts', body);
      return clean({ created: workoutDetail(w), warnings });
    },
  }),
  tool({
    name: 'update_workout',
    title: 'Update planned workout',
    description: `Change fields of a planned workout. Only the fields you pass change; pass null to clear an optional field (startTime, subSport, description, preNote). Replace the steps with \`text\` (workout text syntax, see create_workout) or \`structure\`; set clearStructure to turn it into an unstructured session. Changing the date moves it (prefer move_workout). Planned totals are re-derived; a workout already on the watch is re-sent on the next sync. scope 'following' applies the change to the rest of its repeating series.`,
    input: z.object({
      id: id('Workout id (wk_…)'),
      title: z.string().max(200).optional().describe('New title ("" = derive from the structure)'),
      date: date('New date').optional(),
      startTime: hhmm.nullable().optional(),
      sport: sport.optional(),
      subSport: subSport.nullable().optional(),
      text: z.string().min(1).max(20_000).optional().describe('New steps in workout text syntax'),
      structure: structureJson.optional().describe('New raw structure JSON (as returned by get_workout includeStructureJson)'),
      clearStructure: z.boolean().optional().describe('Remove the structured steps'),
      plannedDurationSec: z.number().int().positive().max(86_400).nullable().optional().describe('Unstructured: planned duration (s)'),
      plannedDistanceM: z.number().positive().max(1_000_000).nullable().optional().describe('Unstructured: planned distance (m)'),
      intensity: intensity.optional(),
      isKey: z.boolean().optional(),
      description: z.string().max(10_000).nullable().optional(),
      preNote: z.string().max(5_000).nullable().optional(),
      tags: z.array(z.string().max(40)).max(20).optional().describe('Replaces all tags'),
      scope,
    }),
    annotations: WRITE({ destructiveHint: true, idempotentHint: true }),
    run: async ({ id, scope, text, clearStructure, ...rest }, { api }) => {
      if ([text, rest.structure, clearStructure || undefined].filter((x) => x !== undefined).length > 1) {
        throw new ToolError('Give only one of text, structure or clearStructure');
      }
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
      if (text) {
        const cur = await api.get<PlannedWorkout>(`/workouts/${encodeURIComponent(id)}`);
        const p = await parseText(api, rest.sport ?? cur.sport, text, rest.date ?? cur.date);
        patch.structure = p.structure;
      }
      if (clearStructure) patch.structure = null;
      if (!Object.keys(patch).length) throw new ToolError('Nothing to change: pass at least one field');
      const w = await api.send<PlannedWorkout>('PATCH', `/workouts/${encodeURIComponent(id)}?scope=${scope}`, patch);
      return { updated: workoutDetail(w) };
    },
  }),
  tool({
    name: 'move_workout',
    title: 'Move planned workout',
    description: "Move a planned workout to another date (and optionally time). scope 'following' shifts this and the later workouts of its series by the same number of days.",
    input: z.object({ id: id('Workout id (wk_…)'), date: date('New date'), startTime: hhmm.nullable().optional(), scope }),
    annotations: WRITE({ idempotentHint: true }),
    run: async ({ id, date, startTime, scope }, { api }) => {
      const w = await api.send<PlannedWorkout>('PATCH', `/workouts/${encodeURIComponent(id)}?scope=${scope}`, clean({ date, startTime }));
      return { moved: workoutSummary(w) };
    },
  }),
  tool({
    name: 'delete_workout',
    title: 'Delete planned workout',
    description:
      "Permanently delete a planned workout (also removes it from the Garmin watch calendar if it was sent there). Cannot be undone through this API. To keep the history of a session the athlete won't do, use skip_workout instead. scope 'following' deletes this and the later workouts of its series.",
    input: z.object({ id: id('Workout id (wk_…)'), scope }),
    annotations: WRITE({ destructiveHint: true, idempotentHint: true }),
    run: async ({ id, scope }, { api }) => {
      const r = await api.send<{ deleted: PlannedWorkout[] }>('DELETE', `/workouts/${encodeURIComponent(id)}?scope=${scope}`);
      return { deleted: r.deleted.map((w) => ({ id: w.id, date: w.date, title: w.title })) };
    },
  }),
  tool({
    name: 'skip_workout',
    title: 'Skip / un-skip planned workout',
    description: 'Mark a planned workout as skipped with a reason (it then counts as excused, not missed), or set unskip=true to restore it to planned.',
    input: z.object({
      id: id('Workout id (wk_…)'),
      reason: z.enum(SKIP_REASONS).default('other').describe('Why it was skipped'),
      unskip: z.boolean().default(false).describe('true = undo a previous skip'),
    }),
    annotations: WRITE({ idempotentHint: true }),
    run: async ({ id, reason, unskip }, { api }) => {
      const path = `/workouts/${encodeURIComponent(id)}/skip`;
      const w = unskip ? await api.send<PlannedWorkout>('DELETE', path) : await api.send<PlannedWorkout>('POST', path, { reason });
      return { workout: workoutSummary(w) };
    },
  }),
  tool({
    name: 'list_templates',
    title: 'Workout library',
    description: 'Workout templates in the library (filterable). Each has its steps as workout text and planned totals for the current thresholds. Schedule one with create_workout { templateId, date }.',
    input: z.object({
      sport: sport.optional(),
      intensity: intensity.optional(),
      q: z.string().max(200).optional().describe('Text search in title / description / tags'),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    annotations: READ,
    run: async ({ limit, ...q }, { api }) => {
      const list = await api.get<Template[]>('/templates', q);
      return { count: list.length, templates: list.slice(0, limit).map(templateSummary), ...(list.length > limit ? { truncated: true } : {}) };
    },
  }),

  // ── activities ──
  tool({
    name: 'list_activities',
    title: 'List activities',
    description:
      'Completed activities, newest first, with summary metrics (duration s, distance m, load, avg/max HR bpm, power W, pace) and compliance vs the paired plan, plus totals over the whole filtered set. Paginate with the returned nextCursor.',
    input: z.object({
      from: date('First day').optional(),
      to: date('Last day').optional(),
      sport: sport.optional(),
      q: z.string().max(200).optional().describe('Search title, notes, tags, location'),
      keyOnly: z.boolean().optional().describe('Only key sessions'),
      intensity: intensity.optional(),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().max(200).optional().describe('nextCursor from a previous call'),
    }),
    annotations: READ,
    run: async ({ keyOnly, ...q }, { api }) => {
      const r = await api.get<{ items: Activity[]; totals: Record<string, number>; nextCursor?: string }>('/activities', {
        ...q,
        ...(keyOnly ? { key: 'true' } : {}),
      });
      return clean({
        activities: r.items.map(activitySummary),
        totals: clean({
          count: r.totals.count,
          durationSec: round(r.totals.durationSec),
          movingSec: round(r.totals.movingSec),
          distanceM: round(r.totals.distanceM),
          load: round(r.totals.load),
          elevationGainM: round(r.totals.elevationGainM),
        }),
        nextCursor: r.nextCursor,
      });
    },
  }),
  tool({
    name: 'get_activity',
    title: 'Get activity',
    description:
      "One completed activity: summary metrics, the planned workout it was paired with (plan vs actual: planned totals + compliance, plus a step-by-step `execution` analysis with an adherence score 0–100 and per-step verdicts when available), laps, time in HR/power/pace zones, peak powers / best efforts, strength sets, thresholds used, and the previous similar session for comparison. Streams (per-second data) are excluded unless you request `streams` — they are downsampled to at most `maxPoints` points (t = seconds from start; speed m/s; altitude m; distance m; grade fraction).",
    input: z.object({
      id: id('Activity id (act_…)'),
      laps: z.boolean().default(true).describe('Include laps / intervals'),
      zones: z.boolean().default(true).describe('Include time in zones'),
      peaks: z.boolean().default(false).describe('Include peak powers, peak HR and best efforts'),
      streams: z
        .object({
          channels: z.array(z.enum(STREAM_CHANNELS)).min(1).max(STREAM_CHANNELS.length).default(['hr', 'power', 'speed']),
          maxPoints: z.number().int().min(10).max(1000).default(200),
        })
        .optional()
        .describe('Request downsampled time series'),
    }),
    annotations: READ,
    run: async ({ id, laps, zones, peaks, streams }, { api }) => {
      const enc = encodeURIComponent(id);
      const d = await api.get<ActivityDetail>(`/activities/${enc}`);
      const out: Record<string, unknown> = activityDetail(d, { laps, zones, peaks });
      const execution = executionAnalysis(d, d.sport);
      if (execution !== undefined) out.execution = execution;
      if (streams) {
        if (!d.hasStreams) out.streams = { unavailable: 'This activity has no recorded streams' };
        else {
          const s = await api.get<ActivityStreams>(`/activities/${enc}/streams`, { maxPoints: streams.maxPoints });
          const cols: Record<string, unknown> = { tSec: s.t.map((v) => Math.round(v)) };
          for (const ch of streams.channels) {
            const col = s[ch];
            if (!col?.some((v) => v !== null)) continue;
            const dp = ch === 'lat' || ch === 'lng' ? 5 : ch === 'speed' || ch === 'grade' ? 3 : ch === 'altitude' ? 1 : 0;
            cols[ch] = col.map((v) => (v === null ? null : round(v, dp)));
          }
          out.streams = { points: s.t.length, ...cols };
        }
      }
      return out;
    },
  }),

  // ── trends ──
  tool({
    name: 'get_fitness_trend',
    title: 'Fitness / fatigue / form trend',
    description:
      "Daily training load and the fitness model: fitness (42-day load average), fatigue (7-day), form (yesterday's fitness − fatigue), formPct (form as % of fitness) with zone (transition > +25 %, fresh, neutral, productive, overreaching < −30 %), ramp (7-day fitness change). Future days up to 8 weeks ahead are projected from the plan (projected: true). Defaults: last 90 days + 14 days ahead. Ranges over 120 days are returned weekly (every 7th day) unless resolution='day'. Optional sport restricts load to one sport.",
    input: z.object({
      from: date('First day').optional(),
      to: date('Last day').optional(),
      sport: sport.optional(),
      resolution: z.enum(['auto', 'day', 'week']).default('auto'),
    }),
    annotations: READ,
    run: async ({ from, to, sport, resolution }, { api }) => {
      const t = await today(api);
      const f = from ?? addDays(t, -90);
      const e = to ?? addDays(t, 14);
      const n = span(f, e, 3 * 366);
      const r = await api.get<{ days: FitnessDay[]; thresholdChanges: Threshold[] }>('/trends/fitness', clean({ from: f, to: e, sport }));
      const weekly = resolution === 'week' || (resolution === 'auto' && n > 120);
      const days = weekly ? r.days.filter((_, i) => (r.days.length - 1 - i) % 7 === 0) : r.days;
      return clean({
        from: f,
        to: r.days.at(-1)?.date ?? e,
        today: t,
        resolution: weekly ? 'week (every 7th day; load is that day only)' : 'day',
        days: days.map(fitnessDay),
        thresholdChanges: r.thresholdChanges.length ? r.thresholdChanges.map((x) => clean({ kind: x.kind, sport: x.sport, value: x.value, effectiveFrom: x.effectiveFrom })) : undefined,
      });
    },
  }),
  tool({
    name: 'get_weekly_summary',
    title: 'Weekly summaries',
    description:
      'Per ISO week (Mon–Sun): planned vs done time (s), load and distance (m), per-sport breakdown, key sessions planned/done, compliance %, easy/moderate/hard time split (s), end-of-week fitness/fatigue/form, week-over-week load change, and weekly targets. Give a range (from/to, max 52 weeks) or `weeks` back from today.',
    input: z.object({
      from: date('Any day in the first week').optional(),
      to: date('Any day in the last week').optional(),
      weeks: z.number().int().min(1).max(52).default(8).describe('Used when from is omitted: this many weeks ending with the week of `to` (default today)'),
    }),
    annotations: READ,
    run: async ({ from, to, weeks }, { api }) => {
      const end = to ?? (await today(api));
      let n = weeks;
      if (from) n = Math.ceil(span(from, end, 52 * 7 + 6) / 7) + 1;
      const list = await api.get<WeekSummary[]>('/trends/weekly', { weeks: Math.min(n, 52), end });
      return { weeks: list.filter((w) => !from || w.endDate >= from).map(weekSummary) };
    },
  }),
  tool({
    name: 'get_wellness',
    title: 'Wellness',
    description:
      'Daily wellness for a range (max 120 days; default last 14 days): HRV (ms) with 7-day baseline band, resting HR (bpm) vs 60-day trend, sleep (s) and score, body battery, stress, weight (kg), device readiness, VO2max, the morning check-in (feel 1–5, soreness 1–5, note), that day\'s load, and the app\'s readiness heuristic (not medical).',
    input: z.object({ from: date('First day').optional(), to: date('Last day').optional() }),
    annotations: READ,
    run: async ({ from, to }, { api }) => {
      const e = to ?? (await today(api));
      const f = from ?? addDays(e, -13);
      span(f, e, 120);
      const r = await api.get<{ days: (WellnessDay & { load: number; hrvBaseline: unknown; restingHrTrend: unknown; readiness: unknown })[] }>('/trends/wellness', { from: f, to: e });
      return {
        from: f,
        to: e,
        days: r.days.map((d) => clean({ ...wellnessDay(d), load: round(d.load) || undefined, hrvBaseline: d.hrvBaseline, restingHrTrend: d.restingHrTrend, readiness: d.readiness })),
      };
    },
  }),

  // ── body weight ──
  tool({
    name: 'log_weight',
    title: 'Log weight',
    description:
      "Log a body-weight reading (kg) for a day (default today; not in the future). One reading per day — logging again replaces it; pass weightKg null to remove the day's reading. The same value appears in the Day page check-in and the Wellness chart. Logging the newest reading also updates the dated weight threshold (used for W/kg) when it moves by ≥ 0.5 kg. Returns the updated trend and goal progress.",
    input: z.object({
      weightKg: z.number().min(25).max(300).nullable().describe('Body weight in kg (null removes the reading)'),
      date: date('Day of the reading').optional(),
    }),
    annotations: WRITE({ idempotentHint: true }),
    run: async ({ weightKg, date: d }, { api }) => {
      const day = d ?? (await today(api));
      const r = await api.send<{ date: string; weightKg: number | null; thresholdUpdated: boolean }>('PUT', `/weight/${day}`, { weightKg });
      const w = await api.get<WeightSummary>('/weight');
      return { logged: r, weight: weightHeadline(w) };
    },
  }),
  tool({
    name: 'get_weight',
    title: 'Weight trend',
    description:
      'Body-weight log and trend for a range (default last 90 days, max 730): every logged reading with the smoothed trend that day, plus latest reading, trend (7-day exponential average, gaps interpolated), trend change over 7/28 days, rate in kg/week (least-squares over 28 days, negative = losing) and goal progress (target, remaining kg, % done, required kg/week for the target date, projected arrival, status reached|on_track|behind|wrong_direction|no_data). Scale readings swing ±1 kg day to day; reason from the trend and rate, not single readings.',
    input: z.object({ from: date('First day').optional(), to: date('Last day').optional() }),
    annotations: READ,
    run: async ({ from, to }, { api }) => {
      if (from && to) span(from, to, 730);
      const w = await api.get<WeightSummary>('/weight', { from, to });
      return {
        from: w.from,
        to: w.to,
        ...weightHeadline(w),
        readings: w.series.filter((p) => p.weightKg !== undefined).map((p) => ({ date: p.date, weightKg: p.weightKg, trendKg: p.trendKg })),
      };
    },
  }),
  tool({
    name: 'set_weight_goal',
    title: 'Set weight goal',
    description:
      'Set (or replace) the body-weight goal: targetKg and an optional targetDate (future). Progress is measured from startKg on startDate — by default the current trend and today. Pass clear: true to remove the goal. A sustainable loss rate is roughly 0.25–0.75 kg/week (≈0.5–1 % of body weight); faster loss while building running volume raises injury and illness risk.',
    input: z.object({
      targetKg: z.number().min(25).max(300).optional().describe('Goal weight in kg'),
      targetDate: date('Target date').optional(),
      startKg: z.number().min(25).max(300).optional().describe('Override the starting weight (default: current trend)'),
      startDate: date('Start date').optional(),
      clear: z.boolean().optional().describe('Remove the goal'),
    }),
    annotations: WRITE({ idempotentHint: true }),
    run: async ({ targetKg, targetDate, startKg, startDate, clear }, { api }) => {
      if (clear) return { cleared: true, weight: weightHeadline(await api.send<WeightSummary>('DELETE', '/weight/goal')) };
      if (targetKg === undefined) throw new ToolError('Give targetKg (or clear: true)');
      const w = await api.send<WeightSummary>('PUT', '/weight/goal', clean({ targetKg, targetDate, startKg, startDate }));
      return { weight: weightHeadline(w) };
    },
  }),

  // ── settings ──
  tool({
    name: 'get_thresholds',
    title: 'Thresholds',
    description:
      'Current thresholds per sport with zone tables, plus the full dated history of threshold entries (kind, sport, value in native units: ftp/row_threshold W, run_threshold and swim_css m/s, lthr/hr_max/hr_rest bpm, weight kg; effectiveFrom; source manual/garmin/estimated). A metric on date D uses the latest entry with effectiveFrom ≤ D.',
    input: z.object({ historyLimit: z.number().int().min(0).max(500).default(50).describe('Newest history entries to include') }),
    annotations: READ,
    run: async ({ historyLimit }, { api }) => {
      const [zones, all] = await Promise.all([api.get<ZonesResponse>('/zones'), api.get<Threshold[]>('/thresholds')]);
      const history = [...all].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)).slice(0, historyLimit);
      return {
        today: zones.date,
        current: zonesOut(zones),
        history: history.map((t) =>
          clean({
            id: t.id,
            kind: t.kind,
            sport: t.sport,
            value: t.value,
            pace: t.kind === 'run_threshold' ? paceOf(t.value, 'run') : t.kind === 'swim_css' ? paceOf(t.value, 'swim') : undefined,
            effectiveFrom: t.effectiveFrom,
            source: t.source,
            note: t.note,
          }),
        ),
      };
    },
  }),
  tool({
    name: 'set_threshold',
    title: 'Set threshold',
    description:
      "Record a new threshold value effective from a date (default today). Kinds and units: ftp (W, bike), run_threshold (threshold pace — pass `pace` as \"m:ss\" per km, or `value` in m/s), swim_css (critical swim speed — `pace` \"m:ss\" per 100 m, or m/s), row_threshold (W), lthr / hr_max / hr_rest (bpm; sport defaults to 'all', or give a sport for a sport-specific value), weight (kg). Activities from that date on are re-analysed and planned workouts re-derived in the background.",
    input: z.object({
      kind: z.enum(THRESHOLD_KINDS),
      value: z.number().positive().optional().describe('Value in native units (W, m/s, bpm, kg)'),
      pace: z.string().optional().describe('run_threshold: "m:ss" per km; swim_css: "m:ss" per 100 m'),
      sport: z.enum(['all', ...SPORTS]).optional().describe('Defaults by kind (ftp→bike, run_threshold→run, swim_css→swim, row_threshold→row, others→all)'),
      effectiveFrom: date('Effective from').optional(),
      note: z.string().max(500).optional(),
    }),
    annotations: WRITE(),
    run: async ({ kind, value, pace, sport, effectiveFrom, note }, { api }) => {
      let v = value;
      if (pace !== undefined) {
        const sec = parseClock(pace);
        if (kind !== 'run_threshold' && kind !== 'swim_css') throw new ToolError('`pace` only applies to run_threshold and swim_css');
        if (!sec) throw new ToolError('pace must look like "4:15"');
        v = (kind === 'run_threshold' ? 1000 : 100) / sec;
      }
      if (v === undefined) throw new ToolError('Give value (or pace for run_threshold / swim_css)');
      const defaults: Record<ThresholdKind, Sport | 'all'> = { ftp: 'bike', run_threshold: 'run', swim_css: 'swim', row_threshold: 'row', lthr: 'all', hr_max: 'all', hr_rest: 'all', weight: 'all' };
      const saved = await api.send<Threshold>('POST', '/thresholds', clean({
        kind,
        sport: sport ?? defaults[kind],
        value: round(v, kind === 'run_threshold' || kind === 'swim_css' ? 4 : 1),
        effectiveFrom: effectiveFrom ?? (await today(api)),
        source: 'manual',
        note,
      }));
      return {
        saved: clean({ ...saved, pace: kind === 'run_threshold' ? paceOf(saved.value, 'run') : kind === 'swim_css' ? paceOf(saved.value, 'swim') : undefined }),
        note: 'Metrics and planned totals from effectiveFrom on are being recomputed in the background.',
      };
    },
  }),
  tool({
    name: 'list_events',
    title: 'List events',
    description: 'Events (races, tests, milestones) with priority A (main goal) / B / C, sport, distance (m), goal, location. Defaults to all events from today on.',
    input: z.object({ from: date('First day').optional(), to: date('Last day').optional(), includePast: z.boolean().default(false).describe('Ignore the from default and list every event') }),
    annotations: READ,
    run: async ({ from, to, includePast }, { api }) => {
      const f = from ?? (includePast ? undefined : await today(api));
      const list = await api.get<Event[]>('/events', clean({ from: f, to }));
      return { events: list.map(eventOut) };
    },
  }),
  tool({
    name: 'create_event',
    title: 'Create event',
    description: 'Add an event (race / test / milestone) to the calendar. Priority A = season goal, B = important, C = training race.',
    input: z.object({
      date: date('Event date'),
      name: z.string().min(1).max(200),
      priority: z.enum(['A', 'B', 'C']).default('B'),
      sport: sport.optional(),
      distanceM: z.number().positive().max(1_000_000).optional().describe('Distance in metres'),
      goal: z.string().max(500).optional().describe('e.g. "sub 3:15"'),
      location: z.string().max(200).optional(),
      note: z.string().max(5000).optional(),
    }),
    annotations: WRITE(),
    run: async (a, { api }) => ({ created: eventOut(await api.send<Event>('POST', '/events', clean(a))) }),
  }),
  tool({
    name: 'update_event',
    title: 'Update event',
    description: 'Change fields of an event; only the fields you pass change, null clears an optional field.',
    input: z.object({
      id: id('Event id (evt_…)'),
      date: date('Event date').optional(),
      name: z.string().min(1).max(200).optional(),
      priority: z.enum(['A', 'B', 'C']).optional(),
      sport: sport.nullable().optional(),
      distanceM: z.number().positive().max(1_000_000).nullable().optional(),
      goal: z.string().max(500).nullable().optional(),
      location: z.string().max(200).nullable().optional(),
      note: z.string().max(5000).nullable().optional(),
    }),
    annotations: WRITE({ destructiveHint: true, idempotentHint: true }),
    run: async ({ id, ...patch }, { api }) => {
      const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      if (!Object.keys(body).length) throw new ToolError('Nothing to change: pass at least one field');
      return { updated: eventOut(await api.send<Event>('PATCH', `/events/${encodeURIComponent(id)}`, body)) };
    },
  }),
  tool({
    name: 'delete_event',
    title: 'Delete event',
    description: 'Permanently delete an event (workouts linked to it are kept, just unlinked).',
    input: z.object({ id: id('Event id (evt_…)') }),
    annotations: WRITE({ destructiveHint: true, idempotentHint: true }),
    run: async ({ id }, { api }) => ({ deleted: eventOut(await api.send<Event>('DELETE', `/events/${encodeURIComponent(id)}`)) }),
  }),
  tool({
    name: 'set_day_note',
    title: 'Set day note',
    description: 'Write (replace) the free-text note for a calendar day, e.g. how the athlete felt or plan context. An empty body deletes the note.',
    input: z.object({ date: date('Day'), body: z.string().max(50_000).describe('Note text (markdown); "" deletes it') }),
    annotations: WRITE({ destructiveHint: true, idempotentHint: true }),
    run: async ({ date, body }, { api }) => {
      const r = await api.send<DayNote | null>('PUT', `/day-notes/${date}`, { body });
      return r ? { date: r.date, note: r.body, updatedAt: r.updatedAt } : { date, note: null, deleted: true };
    },
  }),

  // ── garmin ──
  tool({
    name: 'sync_now',
    title: 'Sync with Garmin now',
    description:
      'Run a Garmin sync now: pull new/changed activities and wellness, apply thresholds reported by Garmin, and push pending planned workouts to the watch. Normally this runs every 30 minutes on its own. Returns counts and a one-line summary. Fails with a clear message when Garmin is not connected, already syncing, or rate limited.',
    input: z.object({}),
    annotations: WRITE({ idempotentHint: true, openWorldHint: true }),
    run: async (_a, { api }) => {
      const r = await api.send<{ status: string; summary: string; activities: unknown; wellnessDays: number; thresholds: number; push: unknown; durationMs: number }>('POST', '/garmin/sync');
      return { status: r.status, summary: r.summary, activities: r.activities, wellnessDays: r.wellnessDays, thresholdsFromGarmin: r.thresholds, push: r.push, durationMs: r.durationMs };
    },
  }),
  tool({
    name: 'push_workout_to_watch',
    title: 'Send workout to Garmin watch',
    description:
      'Send one planned workout to Garmin Connect (creates or replaces it and schedules it on its date so it syncs to the watch). Needs a Garmin connection with write access (a Connect token); a read-only Personal API key cannot push. Upcoming workouts are also pushed automatically on each sync.',
    input: z.object({ workoutId: id('Workout id (wk_…)') }),
    annotations: WRITE({ idempotentHint: true, openWorldHint: true }),
    run: async ({ workoutId }, { api }) => {
      const g = await api.get<GarminStatusResponse>('/garmin/status');
      if (!g.connected) throw new ToolError('Garmin is not connected. The athlete must connect Garmin in Hermes (Settings → Garmin) first.');
      if (!g.capabilities.write) {
        throw new ToolError('Garmin is connected read-only (Personal API key). Pushing workouts needs a Garmin Connect token: Settings → Garmin → "Also send workouts to my watch".');
      }
      const link = await api.send<Record<string, unknown>>('POST', `/garmin/push/${encodeURIComponent(workoutId)}`);
      return { workoutId, garmin: clean(link) };
    },
  }),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
