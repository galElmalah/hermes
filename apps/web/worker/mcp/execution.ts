/**
 * Plan-vs-actual execution analysis for `get_activity` / `get_workout`.
 *
 * The analysis itself is the "execution analysis" feature (packages/core workout/execution.ts,
 * docs/MOBILE_API.md §4): the API embeds it as `execution` on `GET /activities/:id` and
 * `GET /workouts/:id` when the pair exists. This hook only compacts it for agents; when the API
 * does not (yet) provide it, it returns undefined and the tools fall back to the planned workout
 * and overall compliance.
 */
import type { ExecutionAnalysis, Sport } from '@cadence/core/domain';
import { clean, paceOf, round } from './format';

export function executionAnalysis(source: { execution?: ExecutionAnalysis }, sport: Sport) {
  const x = source.execution;
  if (!x) return undefined;
  return clean({
    score: round(x.score),
    state: x.state,
    summary: x.summary,
    method: x.method,
    confidence: x.confidence,
    note: x.note,
    counts: x.counts,
    planned: clean({ ...x.planned }),
    actual: clean({ ...x.actual }),
    steps: x.steps.map((s) =>
      clean({
        label: s.label,
        verdict: s.verdict,
        score: round(s.score),
        deviation: s.deviation,
        target: s.planned?.target?.text ?? s.planned?.targetText ?? undefined,
        plannedDurationSec: round(s.planned?.durationSec),
        plannedDistanceM: round(s.planned?.distanceM),
        actualDurationSec: round(s.actual?.durationSec),
        actualDistanceM: round(s.actual?.distanceM),
        avgHrBpm: round(s.actual?.avgHr),
        avgPowerW: round(s.actual?.avgPower),
        avgPace: paceOf(s.actual?.avgSpeedMps ?? undefined, sport),
        inTargetPct: round(s.intensity?.inTargetPct),
      }),
    ),
  });
}
