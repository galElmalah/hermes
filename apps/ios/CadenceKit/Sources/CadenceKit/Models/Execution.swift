import Foundation

// Workout execution (plan vs actual), step by step — docs/MOBILE_API.md §4 "Workout execution",
// zod `ExecutionAnalysis` in packages/core/src/domain.ts. Returned as `execution` on
// `GET /api/activities/:id` and `GET /api/workouts/:id` when the activity and workout are paired.
//
// Display-only analysis: everything decodes leniently. Unknown enum values become `.unknown`, a
// missing or malformed field takes a neutral default, a malformed step is dropped, and an
// analysis without a usable score (`isUsable == false`) is hidden by the app. Decoding these types
// never fails the activity or workout around them.

public enum ExecutionMetric: String, TolerantEnum {
    case speed, power, hr, cadence
    case unknown
}

public enum ExecutionVerdict: String, TolerantEnum {
    case onTarget = "on_target"
    case over, under, skipped, extra
    case unknown
}

public enum ExecutionMethod: String, TolerantEnum {
    case laps, streams, session
    case unknown
}

public enum ExecutionConfidence: String, TolerantEnum {
    case high, medium, low
    case unknown
}

public enum ExecutionMeasure: String, TolerantEnum {
    case time, distance
    case lapButton = "lap_button"
    case reps
    case unknown
}

/// `intensity.verdict`
public enum IntensityVerdict: String, TolerantEnum {
    case on, over, under
    case unknown
}

/// `duration.verdict`
public enum DurationVerdict: String, TolerantEnum {
    case on, long, short
    case unknown
}

public enum DurationBasis: String, TolerantEnum {
    case time, distance
    case unknown
}

extension KeyedDecodingContainer {
    /// The value when present and well-formed, else nil (never throws).
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }
}

/// Decodes an array element by element, dropping the elements that fail.
struct LossyArray<Element: Decodable>: Decodable {
    var elements: [Element]

    /// Accepts any JSON value (decoding it advances the container past a bad element).
    private struct Skip: Decodable {
        init(from decoder: Decoder) throws {}
    }

    init(from decoder: Decoder) throws {
        var c = try decoder.unkeyedContainer()
        var out: [Element] = []
        while !c.isAtEnd {
            if let e = try? c.decode(Element.self) {
                out.append(e)
            } else {
                _ = try? c.decode(Skip.self) // advance past the bad element
            }
        }
        elements = out
    }
}

public struct ExecutionAnalysis: Codable, Hashable, Sendable {
    /// 1; a bump means the semantics changed
    public var version: Int
    public var workoutId: String
    public var activityId: String
    public var method: ExecutionMethod
    public var confidence: ExecutionConfidence
    /// why this method/confidence (small print)
    public var note: String?
    /// adherence 0–100; nil = no usable analysis (the app hides the section)
    public var score: Double?
    public var state: ComplianceState
    /// "Hit 4 of 5 reps; reps ran 6–10 s/km fast; cut the cool-down short"
    public var summary: String
    public var counts: ExecutionCounts
    public var planned: ExecutionTotals
    public var actual: ExecutionTotals
    /// execution order; empty when `method == .session`
    public var steps: [ExecutionStep]

    /// Has a score the app can show.
    public var isUsable: Bool { score.map { $0.isFinite } ?? false }

    public init(version: Int = 1, workoutId: String = "", activityId: String = "", method: ExecutionMethod = .unknown,
                confidence: ExecutionConfidence = .unknown, note: String? = nil, score: Double? = nil,
                state: ComplianceState = .unknown, summary: String = "", counts: ExecutionCounts = ExecutionCounts(),
                planned: ExecutionTotals = ExecutionTotals(), actual: ExecutionTotals = ExecutionTotals(),
                steps: [ExecutionStep] = []) {
        self.version = version; self.workoutId = workoutId; self.activityId = activityId; self.method = method
        self.confidence = confidence; self.note = note; self.score = score; self.state = state; self.summary = summary
        self.counts = counts; self.planned = planned; self.actual = actual; self.steps = steps
    }

    enum CodingKeys: String, CodingKey {
        case version, workoutId, activityId, method, confidence, note, score, state, summary, counts, planned, actual, steps
    }

    public init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init() // not an object: an unusable analysis, hidden by the app
            return
        }
        self.init(version: c.lenient(Int.self, .version) ?? 0,
                  workoutId: c.lenient(String.self, .workoutId) ?? "",
                  activityId: c.lenient(String.self, .activityId) ?? "",
                  method: c.lenient(ExecutionMethod.self, .method) ?? .unknown,
                  confidence: c.lenient(ExecutionConfidence.self, .confidence) ?? .unknown,
                  note: c.lenient(String.self, .note),
                  score: c.lenient(Double.self, .score),
                  state: c.lenient(ComplianceState.self, .state) ?? .unknown,
                  summary: c.lenient(String.self, .summary) ?? "",
                  counts: c.lenient(ExecutionCounts.self, .counts) ?? ExecutionCounts(),
                  planned: c.lenient(ExecutionTotals.self, .planned) ?? ExecutionTotals(),
                  actual: c.lenient(ExecutionTotals.self, .actual) ?? ExecutionTotals(),
                  steps: c.lenient(LossyArray<ExecutionStep>.self, .steps)?.elements ?? [])
    }
}

public struct ExecutionCounts: Codable, Hashable, Sendable {
    public var planned: Int
    public var onTarget: Int
    public var over: Int
    public var under: Int
    public var skipped: Int
    public var extra: Int

    public init(planned: Int = 0, onTarget: Int = 0, over: Int = 0, under: Int = 0, skipped: Int = 0, extra: Int = 0) {
        self.planned = planned; self.onTarget = onTarget; self.over = over; self.under = under
        self.skipped = skipped; self.extra = extra
    }

    enum CodingKeys: String, CodingKey { case planned, onTarget, over, under, skipped, extra }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(planned: c.lenient(Int.self, .planned) ?? 0, onTarget: c.lenient(Int.self, .onTarget) ?? 0,
                  over: c.lenient(Int.self, .over) ?? 0, under: c.lenient(Int.self, .under) ?? 0,
                  skipped: c.lenient(Int.self, .skipped) ?? 0, extra: c.lenient(Int.self, .extra) ?? 0)
    }
}

public struct ExecutionTotals: Codable, Hashable, Sendable {
    public var durationSec: Double?
    public var distanceM: Double?
    public var load: Double?

    public init(durationSec: Double? = nil, distanceM: Double? = nil, load: Double? = nil) {
        self.durationSec = durationSec; self.distanceM = distanceM; self.load = load
    }

    enum CodingKeys: String, CodingKey { case durationSec, distanceM, load }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(durationSec: c.lenient(Double.self, .durationSec), distanceM: c.lenient(Double.self, .distanceM),
                  load: c.lenient(Double.self, .load))
    }
}

public struct ExecutionRepeat: Codable, Hashable, Sendable {
    /// 1-based iteration of the innermost repeat
    public var iteration: Int
    public var count: Int
}

public struct ExecutionTarget: Codable, Hashable, Sendable {
    public var metric: ExecutionMetric
    /// band judged (native units; for speed low = slower)
    public var low: Double?
    public var high: Double?
    public var plannedLow: Double?
    public var plannedHigh: Double?
    /// ramp endpoints
    public var from: Double?
    public var to: Double?
    /// "5:00/km", "238–250 W", "HR Z2 · 147–161 bpm"
    public var text: String?

    enum CodingKeys: String, CodingKey { case metric, low, high, plannedLow, plannedHigh, from, to, text }

    public init(metric: ExecutionMetric, low: Double? = nil, high: Double? = nil, plannedLow: Double? = nil,
                plannedHigh: Double? = nil, from: Double? = nil, to: Double? = nil, text: String? = nil) {
        self.metric = metric; self.low = low; self.high = high; self.plannedLow = plannedLow
        self.plannedHigh = plannedHigh; self.from = from; self.to = to; self.text = text
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(metric: c.lenient(ExecutionMetric.self, .metric) ?? .unknown,
                  low: c.lenient(Double.self, .low), high: c.lenient(Double.self, .high),
                  plannedLow: c.lenient(Double.self, .plannedLow), plannedHigh: c.lenient(Double.self, .plannedHigh),
                  from: c.lenient(Double.self, .from), to: c.lenient(Double.self, .to), text: c.lenient(String.self, .text))
    }
}

/// `step.planned`
public struct ExecutionPlannedStep: Codable, Hashable, Sendable {
    public var measure: ExecutionMeasure
    public var durationSec: Double?
    public var distanceM: Double?
    public var target: ExecutionTarget?
    /// the target as written ("RPE 7"); nil when open
    public var targetText: String?

    enum CodingKeys: String, CodingKey { case measure, durationSec, distanceM, target, targetText }

    public init(measure: ExecutionMeasure, durationSec: Double? = nil, distanceM: Double? = nil,
                target: ExecutionTarget? = nil, targetText: String? = nil) {
        self.measure = measure; self.durationSec = durationSec; self.distanceM = distanceM
        self.target = target; self.targetText = targetText
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(measure: c.lenient(ExecutionMeasure.self, .measure) ?? .unknown,
                  durationSec: c.lenient(Double.self, .durationSec), distanceM: c.lenient(Double.self, .distanceM),
                  target: c.lenient(ExecutionTarget.self, .target), targetText: c.lenient(String.self, .targetText))
    }
}

/// `step.actual`
public struct ExecutionActualStep: Codable, Hashable, Sendable {
    /// seconds from activity start (same axis as streams `t`)
    public var startSec: Double?
    public var endSec: Double?
    /// recorded seconds (pauses excluded)
    public var durationSec: Double?
    public var distanceM: Double?
    public var avgSpeedMps: Double?
    public var avgHr: Double?
    public var avgPower: Double?
    public var avgCadence: Double?

    enum CodingKeys: String, CodingKey { case startSec, endSec, durationSec, distanceM, avgSpeedMps, avgHr, avgPower, avgCadence }

    public init(startSec: Double? = nil, endSec: Double? = nil, durationSec: Double? = nil, distanceM: Double? = nil,
                avgSpeedMps: Double? = nil, avgHr: Double? = nil, avgPower: Double? = nil, avgCadence: Double? = nil) {
        self.startSec = startSec; self.endSec = endSec; self.durationSec = durationSec; self.distanceM = distanceM
        self.avgSpeedMps = avgSpeedMps; self.avgHr = avgHr; self.avgPower = avgPower; self.avgCadence = avgCadence
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(startSec: c.lenient(Double.self, .startSec), endSec: c.lenient(Double.self, .endSec),
                  durationSec: c.lenient(Double.self, .durationSec), distanceM: c.lenient(Double.self, .distanceM),
                  avgSpeedMps: c.lenient(Double.self, .avgSpeedMps), avgHr: c.lenient(Double.self, .avgHr),
                  avgPower: c.lenient(Double.self, .avgPower), avgCadence: c.lenient(Double.self, .avgCadence))
    }
}

/// `step.intensity`
public struct ExecutionIntensity: Codable, Hashable, Sendable {
    public var metric: ExecutionMetric
    /// average in the target's metric (native units)
    public var actual: Double?
    public var actualStart: Double?
    public var actualEnd: Double?
    /// signed distance to the band (native units), 0 inside; + = harder
    public var delta: Double?
    /// delta ÷ band edge (0.04 = 4 % harder)
    public var deltaPct: Double?
    /// pace targets: s per pace unit, + = faster
    public var deltaPaceSec: Double?
    /// % of the step's samples inside the band
    public var inTargetPct: Double?
    public var verdict: IntensityVerdict

    enum CodingKeys: String, CodingKey { case metric, actual, actualStart, actualEnd, delta, deltaPct, deltaPaceSec, inTargetPct, verdict }

    public init(metric: ExecutionMetric, actual: Double? = nil, actualStart: Double? = nil, actualEnd: Double? = nil,
                delta: Double? = nil, deltaPct: Double? = nil, deltaPaceSec: Double? = nil, inTargetPct: Double? = nil,
                verdict: IntensityVerdict = .unknown) {
        self.metric = metric; self.actual = actual; self.actualStart = actualStart; self.actualEnd = actualEnd
        self.delta = delta; self.deltaPct = deltaPct; self.deltaPaceSec = deltaPaceSec; self.inTargetPct = inTargetPct
        self.verdict = verdict
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(metric: c.lenient(ExecutionMetric.self, .metric) ?? .unknown, actual: c.lenient(Double.self, .actual),
                  actualStart: c.lenient(Double.self, .actualStart), actualEnd: c.lenient(Double.self, .actualEnd),
                  delta: c.lenient(Double.self, .delta), deltaPct: c.lenient(Double.self, .deltaPct),
                  deltaPaceSec: c.lenient(Double.self, .deltaPaceSec), inTargetPct: c.lenient(Double.self, .inTargetPct),
                  verdict: c.lenient(IntensityVerdict.self, .verdict) ?? .unknown)
    }
}

/// `step.duration`
public struct ExecutionDuration: Codable, Hashable, Sendable {
    public var basis: DurationBasis
    /// s or m
    public var planned: Double?
    public var actual: Double?
    /// actual − planned
    public var delta: Double?
    public var verdict: DurationVerdict

    enum CodingKeys: String, CodingKey { case basis, planned, actual, delta, verdict }

    public init(basis: DurationBasis, planned: Double? = nil, actual: Double? = nil, delta: Double? = nil,
                verdict: DurationVerdict = .unknown) {
        self.basis = basis; self.planned = planned; self.actual = actual; self.delta = delta; self.verdict = verdict
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(basis: c.lenient(DurationBasis.self, .basis) ?? .unknown, planned: c.lenient(Double.self, .planned),
                  actual: c.lenient(Double.self, .actual), delta: c.lenient(Double.self, .delta),
                  verdict: c.lenient(DurationVerdict.self, .verdict) ?? .unknown)
    }
}

public struct ExecutionStep: Codable, Hashable, Sendable {
    /// index in the unrolled plan; nil for an extra segment
    public var plannedIndex: Int?
    public var stepId: String?
    public var role: StepRole?
    /// "Warm-up", "Rep 2 of 5", "Extra"
    public var label: String
    public var `repeat`: ExecutionRepeat?
    /// share of the overall score, 0–1
    public var weight: Double?
    public var planned: ExecutionPlannedStep?
    public var actual: ExecutionActualStep?
    public var intensity: ExecutionIntensity?
    public var duration: ExecutionDuration?
    public var verdict: ExecutionVerdict
    /// "12 s/km faster than target · ended 0:40 early"; nil when on target
    public var deviation: String?
    /// 0–100 for planned steps; nil for extras
    public var score: Double?

    enum CodingKeys: String, CodingKey {
        case plannedIndex, stepId, role, label, `repeat`, weight, planned, actual, intensity, duration, verdict, deviation, score
    }

    public init(plannedIndex: Int? = nil, stepId: String? = nil, role: StepRole? = nil, label: String,
                repeat: ExecutionRepeat? = nil, weight: Double? = nil, planned: ExecutionPlannedStep? = nil,
                actual: ExecutionActualStep? = nil, intensity: ExecutionIntensity? = nil, duration: ExecutionDuration? = nil,
                verdict: ExecutionVerdict, deviation: String? = nil, score: Double? = nil) {
        self.plannedIndex = plannedIndex; self.stepId = stepId; self.role = role; self.label = label
        self.repeat = `repeat`; self.weight = weight; self.planned = planned; self.actual = actual
        self.intensity = intensity; self.duration = duration; self.verdict = verdict; self.deviation = deviation
        self.score = score
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(plannedIndex: c.lenient(Int.self, .plannedIndex), stepId: c.lenient(String.self, .stepId),
                  role: c.lenient(StepRole.self, .role), label: c.lenient(String.self, .label) ?? "",
                  repeat: c.lenient(ExecutionRepeat.self, .repeat), weight: c.lenient(Double.self, .weight),
                  planned: c.lenient(ExecutionPlannedStep.self, .planned), actual: c.lenient(ExecutionActualStep.self, .actual),
                  intensity: c.lenient(ExecutionIntensity.self, .intensity), duration: c.lenient(ExecutionDuration.self, .duration),
                  verdict: c.lenient(ExecutionVerdict.self, .verdict) ?? .unknown,
                  deviation: c.lenient(String.self, .deviation), score: c.lenient(Double.self, .score))
    }
}
