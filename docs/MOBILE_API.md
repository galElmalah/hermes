# Mobile API contract (iOS app and widgets)

The iOS app (`apps/ios`) talks to the same Worker as the web app. It uses the existing JSON API
(`docs/ARCHITECTURE.md` → API surface; route files in `apps/web/worker/routes/*.ts` are the source of
truth for shapes) plus the three additions below. This file is the contract between the Worker and the
Swift code: both sides implement exactly this.

## 1. Device tokens (bearer auth)

Browsers use the `cadence_session` cookie. Native clients use a revocable **device token**. Both last
**30 days** from the passphrase entry (absolute, no sliding renewal, no refresh): afterwards every
request with that credential is a `401 unauthorized`, and the client asks for the passphrase again. The
iOS app treats that 401 exactly like a revocation (clears the keychain, shows the passphrase screen).

- `POST /api/auth/devices` — open route, same throttling/lockout as `POST /api/auth/login`.
  Request `{ "passphrase": string, "name": string (1–64), "platform": "ios" | "other" | "agent" }`
  (`agent` = an AI agent using the MCP endpoint, `docs/MCP.md`).
  `201` → `{ "token": "cad_<43 url-safe base64 chars>", "device": Device }`. The token expires at
  `device.expiresAt` (30 days after creation).
  `401 invalid_passphrase`, `429 too_many_attempts` (with `Retry-After`), `400 not_configured`.
  The token is returned once; the server stores only its SHA-256 hash.
- `GET /api/auth/devices` → `{ "devices": Device[] }` (newest first, expired ones left out; MCP clients
  connected through OAuth appear here as `agent` devices named after the client). Requires auth.
- `DELETE /api/auth/devices/:id` → `204`. Revokes that device at once. Requires auth.
  `404 not_found` when no such device exists (already revoked).
- `DELETE /api/auth/devices/current` → `204`. Revokes the token used for this request (sign-out on the
  phone). `400 bad_request` when the request is cookie-authenticated.

Request validation failures (empty or > 64-character `name` after trimming, unknown `platform`, missing
fields) → `400 validation`. A wrong passphrase counts towards the same lockout as a failed login, and
failed logins lock out device creation too (one throttle).

```ts
type Device = {
  id: string;            // "dev_…"
  name: string;          // e.g. "Alex's iPhone"
  platform: 'ios' | 'other' | 'agent';
  createdAt: string;     // ISO instant
  lastUsedAt: string | null; // ISO instant, updated at most once per hour
  expiresAt: string;     // ISO instant: the token stops working then (30 days after sign-in)
};
```

Every protected route accepts `Authorization: Bearer cad_…` as an alternative to the cookie. A missing,
unknown, revoked or expired token → `401 { error: { code: "unauthorized", message } }`. A request that carries a
`Bearer` header is judged on that token alone (a bad token is a `401` even if a valid cookie is also
sent); `Authorization` headers with other schemes are ignored. Revocation is immediate in the Worker
isolate that handled it and takes at most 30 s everywhere else (per-isolate cache of valid tokens). Changing the passphrase
revokes all device tokens (same as it invalidates sessions). `GET /api/auth/status` reports
`authenticated: true` for a valid bearer token too.

Storage: migration `0004_devices.sql` — table `devices (id TEXT PRIMARY KEY, name TEXT NOT NULL,
platform TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT)`;
`0007_oauth_and_expiry.sql` adds `expires_at TEXT` (rows that existed then got 30 days from the
migration; a NULL expiry counts as expired). Expired rows are deleted when the next device is created.

## 2. Widget snapshot

`GET /api/mobile/snapshot` → `MobileSnapshot`. One small response (< 8 KB) with everything the widgets,
the Lock Screen and the app's first paint need, so a widget refresh is a single request. SI units;
durations in seconds, distances in metres; dates are `YYYY-MM-DD` in the athlete's time zone.

```ts
type SnapshotSession = {
  id: string;
  kind: 'planned' | 'activity' | 'paired';   // paired = planned workout with its completed activity
  sport: Sport;                               // 'bike' | 'run' | 'swim' | 'row' | 'strength' | … (domain.ts)
  title: string;
  startTime: string | null;                   // "HH:MM" local, planned or actual
  durationSec: number | null;                 // actual when done, else planned
  distanceM: number | null;
  load: number | null;
  isKey: boolean;
  intensity: IntensityClass | null;           // domain.ts
  state: 'planned' | 'done' | 'missed' | 'skipped';
  workoutId: string | null;                   // deep link target …/workouts/:id
  activityId: string | null;                  // deep link target …/activities/:id
};

type MobileSnapshot = {
  generatedAt: string;                        // ISO instant
  today: string;                              // LocalDate
  units: 'metric' | 'imperial';
  athleteName: string | null;
  status: {
    fitness: number | null;                   // rounded to 1 decimal
    fatigue: number | null;
    form: number | null;
    formZone: FormZone | null;                // domain.ts FORM_ZONES
    rampPerWeek: number | null;
    headline: string;                         // one short sentence, e.g. "Neutral · long ride today"
  };
  todaySessions: SnapshotSession[];           // in day order
  tomorrowSessions: SnapshotSession[];
  week: {
    isoWeek: string;                          // "2026-W47"
    label: string;                            // "W47"
    phase: string | null;                     // "Run base"
    doneSec: number; plannedSec: number;
    doneLoad: number; plannedLoad: number;
    keyDone: number; keyPlanned: number;
    days: { date: string; plannedSec: number; doneSec: number;
            state: 'rest' | 'planned' | 'done' | 'partial' | 'missed' }[];   // 7 entries, Mon–Sun
  };
  nextEvent: { id: string; name: string; date: string; daysTo: number; priority: 'A' | 'B' | 'C' } | null;
  fitnessSeries: { date: string; fitness: number; fatigue: number; form: number }[]; // last 42 days incl. today
  recentWeeks: { isoWeek: string; label: string; hours: number; load: number }[];     // last 8 complete weeks + current
  lastActivity: SnapshotSession | null;       // most recent completed activity
  lastSyncAt: string | null;                  // ISO instant of the last successful Garmin sync
};
```

The zod schema lives in `packages/core/src/domain.ts` (`MobileSnapshot`, `SnapshotSession`, `Device`).
The endpoint reuses the same services as `GET /api/today` and the calendar/trends routes — no second
implementation of metrics.

### Snapshot semantics (as implemented)

- `today` follows the athlete's time zone setting and, in demo mode, the pinned demo clock (it is the same
  date `GET /api/today` returns). `generatedAt` is the real server time. `units` is the athlete's display
  preference; every number in the payload is still SI.
- **Sessions** (`todaySessions`, `tomorrowSessions`, `lastActivity`): one entry per planned workout —
  `paired` when it has its completed activity, else `planned` — then one `activity` entry per completed
  activity without a plan. For `paired`: `id` = `workoutId` = the workout, `title` is the planned title,
  `startTime`/`durationSec`/`distanceM`/`load`/`intensity` are the activity's actuals. For `activity`:
  `id` = `activityId`, `workoutId` is non-null only for a pair that crosses dates. Done durations are
  moving time (elapsed when no moving time) — the same rule as the week totals, so the day bars add up.
  `state`: `done` (completed), `skipped` (skipped by the athlete or excused by a sick/injured/travel
  marker), `missed` (date passed, not done), else `planned`. Order: by `startTime`, untimed entries last.
  `lastActivity` may therefore be `paired` (its `activityId` is the activity).
- **`week.days[].state`**: `rest` = nothing planned (or only skipped/excused workouts) and nothing done;
  `done` = something done and nothing left open; `partial` = something done and a planned workout still
  open/missed; `missed` = a past day whose planned workouts were not done; `planned` = today/future with
  open workouts. Day `plannedSec`/`doneSec` sum to the week's `plannedSec`/`doneSec` (= `GET /api/today`
  `week`, `GET /api/trends/weekly`). `phase` is the label of the week's training phase.
- **`status`** = `GET /api/today`'s fitness day; `rampPerWeek` is its `ramp` (Fitness change over 7 days).
  `headline` = `"<Form zone> · <today>"` where `<today>` is `"<title> today"` (the key or first open
  session, `"+ N more"` when several), `"done for today"` or `"rest day"`; without a form zone (no
  history) the prefix is dropped and the first letter capitalised (`"Rest day"`). Display it verbatim.
- **Empty database / no activity history**: `status` numbers and `formZone` are `null`, `fitnessSeries` is
  `[]`, `lastActivity` is `null`; `week.days` still has 7 entries and `recentWeeks` 9 (zeros).
- `fitnessSeries` = `GET /api/trends/fitness` values for the last 42 days (oldest first, ends at `today`).
  `recentWeeks` = 9 entries, oldest first, the last one is the current (incomplete) week; `hours` = done
  hours rounded to 0.1. `nextEvent` = the first event on/after today (ties: A before B before C).
- Numbers are JSON numbers that may or may not have a fraction (`464`, `539.1`): decode as `Double`
  (seconds and metres are whole numbers but still decode them as `Double` or `Int` tolerant of `.0`).
- Response header `Cache-Control: private, no-store`. Typical size 4–6 KB; two D1 round trips.

### Example

A real response from the demo dataset (`fitnessSeries` and `recentWeeks` trimmed to their last 3 entries;
the real arrays have 42 and 9):

```json
{
  "generatedAt": "2026-11-22T05:44:52.361Z",
  "today": "2026-11-21",
  "units": "metric",
  "athleteName": "Jonas Weber",
  "status": {
    "fitness": 65.6,
    "fatigue": 71.5,
    "form": -2,
    "formZone": "neutral",
    "rampPerWeek": 2.5,
    "headline": "Neutral · done for today"
  },
  "todaySessions": [
    {
      "id": "wk_d20261121_1",
      "kind": "paired",
      "sport": "bike",
      "title": "Long ride 2h05 — Gavarres loop",
      "startTime": "09:26",
      "durationSec": 7561,
      "distanceM": 57840,
      "load": 102.6,
      "isKey": true,
      "intensity": "tempo",
      "state": "done",
      "workoutId": "wk_d20261121_1",
      "activityId": "act_uxe16yozne"
    }
  ],
  "tomorrowSessions": [
    {
      "id": "wk_d20261122_1",
      "kind": "planned",
      "sport": "run",
      "title": "Trail run 1h30 — Gavarres",
      "startTime": "09:00",
      "durationSec": 5400,
      "distanceM": null,
      "load": 69.4,
      "isKey": false,
      "intensity": "endurance",
      "state": "planned",
      "workoutId": "wk_d20261122_1",
      "activityId": null
    }
  ],
  "week": {
    "isoWeek": "2026-W47",
    "label": "W47",
    "phase": "Run base",
    "doneSec": 28100,
    "plannedSec": 35087,
    "doneLoad": 464,
    "plannedLoad": 539.1,
    "keyDone": 3,
    "keyPlanned": 3,
    "days": [
      { "date": "2026-11-16", "plannedSec": 5664, "doneSec": 6305, "state": "done" },
      { "date": "2026-11-17", "plannedSec": 6300, "doneSec": 6314, "state": "done" },
      { "date": "2026-11-18", "plannedSec": 5151, "doneSec": 4910, "state": "done" },
      { "date": "2026-11-19", "plannedSec": 3000, "doneSec": 3010, "state": "done" },
      { "date": "2026-11-20", "plannedSec": 2072, "doneSec": 0, "state": "missed" },
      { "date": "2026-11-21", "plannedSec": 7500, "doneSec": 7561, "state": "done" },
      { "date": "2026-11-22", "plannedSec": 5400, "doneSec": 0, "state": "planned" }
    ]
  },
  "nextEvent": {
    "id": "evt_demo_3",
    "name": "Riu Ter Half Marathon",
    "date": "2026-12-27",
    "daysTo": 36,
    "priority": "B"
  },
  "fitnessSeries": [
    { "date": "2026-11-19", "fitness": 66.2, "fatigue": 76.9, "form": -13.6 },
    { "date": "2026-11-20", "fitness": 64.7, "fatigue": 66.7, "form": -10.7 },
    { "date": "2026-11-21", "fitness": 65.6, "fatigue": 71.5, "form": -2 }
  ],
  "recentWeeks": [
    { "isoWeek": "2026-W45", "label": "W45", "hours": 5.8, "load": 195.7 },
    { "isoWeek": "2026-W46", "label": "W46", "hours": 10.9, "load": 647.7 },
    { "isoWeek": "2026-W47", "label": "W47", "hours": 7.8, "load": 464 }
  ],
  "lastActivity": {
    "id": "wk_d20261121_1",
    "kind": "paired",
    "sport": "bike",
    "title": "Long ride 2h05 — Gavarres loop",
    "startTime": "09:26",
    "durationSec": 7561,
    "distanceM": 57840,
    "load": 102.6,
    "isKey": true,
    "intensity": "tempo",
    "state": "done",
    "workoutId": "wk_d20261121_1",
    "activityId": "act_uxe16yozne"
  },
  "lastSyncAt": "2026-11-21T18:02:06.824Z"
}
```

## 3. Wellness check-in from an interactive widget

Uses the existing `PUT /api/wellness/:date` (manual check-in fields). No new endpoint.

## 4. Workout execution (plan vs actual)

How well a completed activity followed its planned workout, step by step: where the athlete overdid
it, where they underdid it, and an overall adherence score. Computed by the Worker on read from the
planned structure, the activity's laps and 1 Hz streams, and the thresholds effective on the
workout date (pure logic: `packages/core/src/workout/execution.ts`; zod schema `ExecutionAnalysis` in
`packages/core/src/domain.ts`). It always reflects the current pairing, plan and thresholds.

### Where it appears

| Endpoint | Field |
|---|---|
| `GET /api/activities/:id` (`ActivityDetail`) | `execution?: ExecutionAnalysis` — present when the activity is paired with a planned workout |
| `GET /api/workouts/:id` (`PlannedWorkoutDetail`) | `execution?: ExecutionAnalysis` — present when the workout is paired with an activity |
| every `PlannedWorkout.compliance` / `Activity.compliance` (calendar, lists, today, week) | `score?: number` (0–100) — present when a structured (per-step) analysis exists; `state` is then derived from it |

Absent (`undefined`) when the workout/activity is not paired. Other endpoints do not embed the full
analysis (only `compliance.score`).

### Shape

SI/native units: seconds, metres, m/s, W, bpm, rpm (spm for runs). All strings are display-ready in
the athlete's unit preference (`settings.units`), sentence case, and should be shown verbatim.

```ts
type ExecutionMetric = 'speed' | 'power' | 'hr' | 'cadence';
type ExecutionVerdict = 'on_target' | 'over' | 'under' | 'skipped' | 'extra';

type ExecutionAnalysis = {
  version: number;                 // 1; bump = semantics changed
  workoutId: string;
  activityId: string;
  method: 'laps' | 'streams' | 'session';
  confidence: 'high' | 'medium' | 'low';
  note: string;                    // why this method/confidence, small print
  score: number;                   // adherence 0–100 (integer)
  state: ComplianceState;          // 'on_target' | 'partial_short' | 'partial_long' | 'off_short' | 'off_long'
  summary: string;                 // "Hit 4 of 5 reps; reps ran 6–10 s/km fast; cut the cool-down short"
  counts: { planned: number; onTarget: number; over: number; under: number; skipped: number; extra: number };
  planned: ExecutionTotals;        // planned totals of the workout
  actual: ExecutionTotals;         // the activity's totals (duration = moving time)
  steps: ExecutionStep[];          // execution order; [] when method === 'session'
};

type ExecutionTotals = { durationSec: number | null; distanceM: number | null; load: number | null };

type ExecutionStep = {
  plannedIndex: number | null;     // index in the unrolled plan (0-based); null for an extra segment
  stepId: string | null;           // Step.id in the workout structure; null for extra
  role: 'warmup' | 'active' | 'recovery' | 'rest' | 'cooldown' | 'other' | null;   // null for extra
  label: string;                   // "Warm-up", "Rep 2 of 5", "Recovery 2 of 5", "Cool-down", "Extra"
  repeat: { iteration: number; count: number } | null;   // 1-based iteration of the innermost repeat
  weight: number;                  // share of the overall score, 0–1 (sums to 1 over all steps)
  planned: {
    measure: 'time' | 'distance' | 'lap_button' | 'reps';
    durationSec: number | null;    // planned (time steps) or estimated
    distanceM: number | null;      // planned (distance steps) or estimated
    target: ExecutionTarget | null;  // null: open, RPE-only, or a threshold needed to resolve it is missing
    targetText: string | null;     // the target as written, even when not measurable ("RPE 7", "open" → null)
  } | null;                        // null for extra
  actual: {
    startSec: number; endSec: number;   // seconds from activity start (same axis as streams `t` / laps)
    durationSec: number;           // recorded seconds in the step (pauses excluded)
    distanceM: number | null;
    avgSpeedMps: number | null; avgHr: number | null; avgPower: number | null; avgCadence: number | null;
  } | null;                        // null when skipped
  intensity: {
    metric: ExecutionMetric;
    actual: number;                // average in the target's metric (native units)
    actualStart?: number;          // ramps only: average over the first 20 % of the step
    actualEnd?: number;            // ramps only: last 20 %
    delta: number;                 // signed distance to the band in native units, 0 inside; + = harder
    deltaPct: number;              // delta ÷ band edge (0.04 = 4 % harder); + = harder
    deltaPaceSec?: number;         // pace targets only: deviation in s per pace unit (km/mi/100m/500m), + = faster
    inTargetPct: number | null;    // % of the step's samples inside the band (null without streams)
    verdict: 'on' | 'over' | 'under';
  } | null;                        // null when the step has no measurable target or no data
  duration: {
    basis: 'time' | 'distance';    // what the step was measured by
    planned: number; actual: number; delta: number;   // s or m; delta = actual − planned
    verdict: 'on' | 'long' | 'short';
  } | null;                        // null for lap-button / reps steps, skipped and extra steps
  verdict: ExecutionVerdict;
  deviation: string | null;        // "12 s/km faster than target · ended 0:40 early"; null when on target
  score: number | null;            // 0–100 for planned steps (skipped = 0); null for extras
};

type ExecutionTarget = {
  metric: ExecutionMetric;
  low: number; high: number;       // band judged (native units, low ≤ high; for speed low = slower)
  plannedLow: number; plannedHigh: number;   // as planned (equal for a point target like 5:00/km)
  from?: number; to?: number;      // ramp endpoints (native units)
  text: string;                    // "5:00/km", "8:03–8:57/km", "238–250 W", "HR Z2 · 147–161 bpm"
};
```

### Semantics

- **Verdict per step.** `over` = too hard *or* too long; `under` = too easy *or* too short (intensity
  wins when both are off; both parts are in `intensity.verdict` / `duration.verdict`). Going faster
  than a rep's target is `over`, never a bonus. `skipped` = planned but not found in the recording.
  `extra` = recorded time that matches no planned step (late start, a walk before the warm-up, an
  added block); extras carry `actual` but no `planned`/`score`.
- **Bands.** A range target is judged on its range with 1 % grace; a point target (e.g. `5:00/km`) is
  widened to ±2.5 % for speed and cadence, ±3 % for power, ±3 bpm for HR. `delta` for a point target is
  measured from the planned point; for a range from the nearest edge. Pace targets are judged on
  stream speed (treadmill runs use the watch's speed). Ramps compare `actualStart`→`actualEnd` with
  `from`→`to`.
- **Duration verdict.** `on` within ±max(10 s, 8 %) for time steps, ±max(20 m, 5 %) for distance steps.
- **Score.** Step score = 60 % intensity (average deviation, with time-in-target) + 40 % duration;
  only the available part when one is missing; easy steps (warm-up, cool-down, recovery, rest) going
  *easier* than their band are penalised at a gentler rate. Overall `score` = weighted mean of step
  scores, weight = planned duration × role weight (active 1.0, other 0.75, warm-up/cool-down/recovery
  0.4, rest 0.25); skipped steps score 0; an extra block of ≥ 3 min that is harder than the plan's easy
  steps counts as a 0-score step with weight 0.3 × its duration. `method === 'session'`: score from the
  totals ratio of `compliance.metric` (100 within ±5 %, 0 at half or double).
- **State.** With a structured analysis (`laps`/`streams`): score ≥ 80 → `on_target`; else the
  weighted direction of the misses picks long vs short, and score ≥ 50 → `partial_*`, < 50 → `off_*`.
  `session`: the existing totals ratio bands (80/120, 50/150).
- **Method & confidence.** `laps` (confidence `high`): one lap per planned step (watch-guided or manual
  lap presses) with a matching duration pattern. `streams`: the recording is segmented on the
  target metric's stream (plus lap marks and pauses) and aligned to the plan by dynamic programming
  that tolerates a late start, extra warm-up, pauses, skipped steps and a cut-short or extended
  session; confidence from the duration fit, the hard/easy contrast and the share of skipped/extra
  time. When no trustworthy alignment exists (no structure, no streams and laps that do not match,
  strength/reps-only plans, or confidence below the floor), `method` is `session`, `steps` is `[]`,
  `confidence` is `low` and `note` says why — clients show the summary and totals only.
- **Units in text.** Pace text and `deltaPaceSec` use `/km` or `/mi` (`settings.units`); swims `/100m`
  (`/100y` for imperial), rows `/500m`.

### Example (abridged: 2 of 12 steps)

```json
{
  "version": 1, "workoutId": "wk_m6o6z2bkjo", "activityId": "act_0ut8lqp7mo",
  "method": "streams", "confidence": "medium",
  "note": "Laps don't line up with the plan's 12 steps; aligned on the pace stream",
  "score": 38, "state": "off_short",
  "summary": "Hit 0 of 5 reps; reps ran 17 s/km slow and short; warm-up too hard",
  "counts": { "planned": 12, "onTarget": 0, "over": 1, "under": 11, "skipped": 0, "extra": 2 },
  "planned": { "durationSec": 3300, "distanceM": 8619, "load": 93.3 },
  "actual": { "durationSec": 3558, "distanceM": 8460, "load": 103 },
  "steps": [
    { "plannedIndex": 1, "stepId": "s_yyd861rwm08", "role": "active", "label": "Rep 1 of 5",
      "repeat": { "iteration": 1, "count": 5 }, "weight": 0.11,
      "planned": { "measure": "time", "durationSec": 240, "distanceM": 800,
                   "target": { "metric": "speed", "low": 3.25, "high": 3.4167, "plannedLow": 3.3333, "plannedHigh": 3.3333, "text": "5:00/km" },
                   "targetText": "5:00/km" },
      "actual": { "startSec": 1920, "endSec": 2220, "durationSec": 300, "distanceM": 930, "avgSpeedMps": 3.1, "avgHr": 145, "avgPower": null, "avgCadence": 170 },
      "intensity": { "metric": "speed", "actual": 3.1, "delta": -0.233, "deltaPct": -0.07, "deltaPaceSec": -22, "inTargetPct": 3, "verdict": "under" },
      "duration": { "basis": "time", "planned": 240, "actual": 300, "delta": 60, "verdict": "long" },
      "verdict": "under", "deviation": "22 s/km slower than target · 1:00 long", "score": 38 },
    { "plannedIndex": null, "stepId": null, "role": null, "label": "Extra", "repeat": null, "weight": 0,
      "planned": null,
      "actual": { "startSec": 0, "endSec": 540, "durationSec": 540, "distanceM": 663, "avgSpeedMps": 1.23, "avgHr": 131, "avgPower": null, "avgCadence": 102 },
      "intensity": null, "duration": null, "verdict": "extra", "deviation": "9:00 not in the plan", "score": null }
  ]
}
```

(Header fields are the real analysis of that treadmill session; the two step objects are abridged and their numbers illustrative.)

## Client rules

- Base URL is fixed per build (`HERMES_SERVER_URL` in apps/ios/Config/Hermes.xcconfig → Info.plist
  `HermesServerURL`); there is no server choice in the app. All requests are HTTPS. Debug builds only may
  override it for a local development server (plain HTTP allowed only for `localhost` and private-network
  hosts).
- Send `Authorization: Bearer <token>`, `Accept: application/json`, and `X-Cadence-Client: ios/<version>`.
- Errors are `{ "error": { "code": string, "message": string } }` with a matching HTTP status.
- `401` on any call → the token was revoked: clear it and return to the passphrase screen. Nothing else
  signs out: offline, timeouts, `5xx` and `429` keep the token and cached data and are retried with backoff.

## Local development server

The Worker runs in `vite dev` (demo mode, seeded synthetic athlete, passphrase `hermes-demo`):

```sh
B=http://localhost:5240/api
# 1. get a device token (returned once)
curl -s -X POST $B/auth/devices -H 'content-type: application/json' \
  -d '{"passphrase":"hermes-demo","name":"Dev iPhone","platform":"ios"}'
# → {"token":"cad_…","device":{"id":"dev_…","name":"Dev iPhone","platform":"ios","createdAt":"…","lastUsedAt":null}}
TOKEN=cad_…
# 2. snapshot
curl -s $B/mobile/snapshot -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' -H 'X-Cadence-Client: ios/0.1'
# 3. sign out
curl -s -X DELETE $B/auth/devices/current -H "Authorization: Bearer $TOKEN"   # → 204
```

A fresh local D1 state needs the `0004_devices` migration first:
`npx wrangler d1 migrations apply DB --local --persist-to .wrangler/<name>` (from `apps/web`).
`POST /api/demo/reset` and re-seeding keep device tokens (like the passphrase).

