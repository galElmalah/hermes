import Foundation

// The "Execution" section of the activity and workout pages: adherence score + one-line summary,
// then one row per step — planned vs actual, a verdict (on target / over / under / skipped /
// extra) and the signed deviation. Over and under differ by symbol, word and sign, never by
// colour alone. Built from `ExecutionAnalysis` (docs/MOBILE_API.md §4); nil when unusable.

extension ExecutionVerdict {
    public var label: String {
        switch self {
        case .onTarget: return "On target"
        case .over: return "Over"
        case .under: return "Under"
        case .skipped: return "Skipped"
        case .extra: return "Extra"
        case .unknown: return "Not judged"
        }
    }

    /// SF Symbol shown next to the word: ↑ over, ↓ under, ✓ on target, – skipped, + extra.
    public var symbol: String {
        switch self {
        case .onTarget: return "checkmark"
        case .over: return "arrow.up"
        case .under: return "arrow.down"
        case .skipped: return "minus"
        case .extra: return "plus"
        case .unknown: return "circle"
        }
    }

    /// Status group (always shown with the symbol and word): on target good, over/under off plan,
    /// skipped serious, extra neutral. The app may tint over and under differently.
    public var tone: AnalysisTone {
        switch self {
        case .onTarget: return .good
        case .over: return .warn
        case .under: return .warn
        case .skipped: return .serious
        case .extra, .unknown: return .neutral
        }
    }
}

public struct ExecutionStepRow: Hashable, Sendable, Identifiable {
    public var id: Int
    /// "Rep 2 of 5", "Warm-up", "Extra"
    public var label: String
    /// "4:00 · 5:00/km" — nil for extras
    public var plannedText: String?
    /// "5:00 · 5:22 /km" — nil when skipped
    public var actualText: String?
    public var verdict: ExecutionVerdict
    /// "−7%", "+0:40", "+22 s/km"; nil on target / skipped / extra without a figure
    public var signedDeviation: String?
    /// the server's words: "22 s/km slower than target · 1:00 long"
    public var deviationText: String?
    /// warm-up, recovery, rest, cool-down (quieter row)
    public var isEasy: Bool
    public var accessibilityLabel: String
}

public struct ExecutionModel: Hashable, Sendable {
    public var workoutId: String
    public var activityId: String
    /// 0…100
    public var score: Double
    /// "58"
    public var scoreText: String
    /// "On plan", "Short", "Well over"…
    public var stateLabel: String
    public var tone: AnalysisTone
    /// one line from the server ("Hit 4 of 5 reps; …")
    public var summary: String
    /// "1 on target · 2 over · 9 under · 1 extra"
    public var countsText: String?
    /// "Planned 55:00 · 8.6 km → done 59:18 · 8.5 km"
    public var totalsText: String?
    /// small print: how it was matched and how sure ("Aligned on the pace stream · medium confidence")
    public var methodText: String?
    /// per step, execution order (empty for a session-level analysis)
    public var steps: [ExecutionStepRow]
    public var accessibilityLabel: String

    /// nil when the analysis has no usable score (the section is hidden).
    public init?(_ e: ExecutionAnalysis?, sport: Sport, units: UnitSystem) {
        guard let e, e.isUsable, let raw = e.score else { return nil }
        let score = min(100, max(0, raw))
        workoutId = e.workoutId
        activityId = e.activityId
        self.score = score
        scoreText = Format.number(score)
        switch e.state {
        case .onTarget: stateLabel = "On plan"
        case .unknown: stateLabel = "Done"
        default: stateLabel = e.state.deviationLabel ?? "Done"
        }
        tone = e.state == .unknown ? .neutral : AnalysisTone.of(e.state)
        summary = e.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let c = e.counts
        let parts: [(Int, String)] = [(c.onTarget, "on target"), (c.over, "over"), (c.under, "under"),
                                      (c.skipped, "skipped"), (c.extra, "extra")]
        let counts = parts.filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }
        countsText = counts.isEmpty ? nil : counts.joined(separator: Format.dot)
        totalsText = ExecutionModel.totals(e.planned, e.actual, sport: sport, units: units)
        var method: [String] = []
        if let note = e.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty { method.append(note) }
        if e.confidence != .unknown { method.append("\(e.confidence.rawValue) confidence") }
        methodText = method.isEmpty ? nil : method.joined(separator: Format.dot)
        steps = e.steps.enumerated().map { i, s in ExecutionModel.row(s, index: i, sport: sport, units: units) }
        var spoken = "Adherence \(scoreText) out of 100, \(stateLabel.lowercased())."
        if !summary.isEmpty { spoken += " " + summary }
        accessibilityLabel = spoken
    }

    static func totals(_ p: ExecutionTotals, _ a: ExecutionTotals, sport: Sport, units: UnitSystem) -> String? {
        func text(_ t: ExecutionTotals) -> String? {
            var parts: [String] = []
            if let d = t.durationSec, d > 0 { parts.append(Format.duration(d, style: .hms)) }
            if let m = t.distanceM, m > 0, sport.style.hasDistance { parts.append(Format.distance(m, sport: sport, units: units)) }
            return parts.isEmpty ? nil : parts.joined(separator: Format.dot)
        }
        guard let planned = text(p), let actual = text(a) else { return nil }
        return "Planned \(planned) \u{2192} done \(actual)"
    }

    /// Actual average in the target's metric: "5:22 /km", "245 W", "152 bpm", "88 rpm".
    static func intensityText(_ metric: ExecutionMetric, _ v: Double?, sport: Sport, units: UnitSystem) -> String? {
        guard let v, v.isFinite else { return nil }
        switch metric {
        case .speed: return Format.speedOrPace(v, sport: sport, units: units)
        case .power: return Format.power(v)
        case .hr: return Format.heartRate(v)
        case .cadence: return Format.number(v) + Format.unitSpace + (sport == .bike ? "rpm" : "spm")
        case .unknown: return nil
        }
    }

    /// The signed figure next to the verdict: pace in s per unit (+ = faster), else intensity %
    /// (+ = harder), else the duration difference (+ = longer).
    static func signedDeviation(_ s: ExecutionStep, sport: Sport, units: UnitSystem) -> String? {
        if let i = s.intensity, i.verdict == .over || i.verdict == .under {
            if let p = i.deltaPaceSec, p.isFinite, i.metric == .speed, Format.usesPace(sport) {
                let basis = Format.paceBasis(sport: sport, units: units).label.dropFirst() // "km"
                return "\(Format.signed(p)) s/\(basis)"
            }
            if let pct = i.deltaPct, pct.isFinite { return Format.percent(pct, signed: true) }
        }
        if let d = s.duration, d.verdict == .long || d.verdict == .short, let delta = d.delta, delta.isFinite {
            switch d.basis {
            case .distance:
                let text = Format.distance(abs(delta), sport: sport, units: units)
                return (delta > 0 ? "+" : "\u{2212}") + text
            default:
                return (delta > 0 ? "+" : "\u{2212}") + Format.duration(abs(delta), style: .hms)
            }
        }
        return nil
    }

    static func row(_ s: ExecutionStep, index: Int, sport: Sport, units: UnitSystem) -> ExecutionStepRow {
        var planned: String?
        if let p = s.planned {
            var parts: [String] = []
            switch p.measure {
            case .distance:
                if let m = p.distanceM, m > 0 { parts.append(Format.distance(m, sport: sport, units: units)) }
            case .lapButton:
                parts.append("Lap button")
            default:
                if let d = p.durationSec, d > 0 { parts.append(Format.duration(d, style: .hms)) }
                else if let m = p.distanceM, m > 0 { parts.append(Format.distance(m, sport: sport, units: units)) }
            }
            if let t = p.target?.text ?? p.targetText, !t.isEmpty { parts.append(t) }
            planned = parts.isEmpty ? nil : parts.joined(separator: Format.dot)
        }
        var actual: String?
        if let a = s.actual, s.verdict != .skipped {
            var parts: [String] = []
            let byDistance = s.duration?.basis == .distance || s.planned?.measure == .distance
            if byDistance, let m = a.distanceM, m > 0 {
                parts.append(Format.distance(m, sport: sport, units: units))
            } else if let d = a.durationSec, d > 0 {
                parts.append(Format.duration(d, style: .hms))
            }
            if let i = s.intensity, let t = intensityText(i.metric, i.actual, sport: sport, units: units) {
                parts.append(t)
            } else if s.planned == nil || s.intensity == nil, let hr = a.avgHr, hr > 0, s.verdict == .extra {
                parts.append(Format.heartRate(hr))
            }
            actual = parts.isEmpty ? nil : parts.joined(separator: Format.dot)
        }
        let deviation = s.deviation?.trimmingCharacters(in: .whitespacesAndNewlines)
        let signed = s.verdict == .onTarget ? nil : signedDeviation(s, sport: sport, units: units)
        let label = s.label.isEmpty ? (s.verdict == .extra ? "Extra" : "Step \(index + 1)") : s.label
        let easy: Bool
        switch s.role {
        case .warmup?, .cooldown?, .recovery?, .rest?: easy = true
        default: easy = false
        }
        var spoken = "\(label): \(s.verdict.label.lowercased())"
        if let signed { spoken += ", \(signed)" }
        if let planned { spoken += ". Planned \(planned)" }
        if let actual { spoken += ". Did \(actual)" }
        if let deviation, !deviation.isEmpty { spoken += ". \(deviation)" }
        return ExecutionStepRow(id: index, label: label, plannedText: planned, actualText: actual, verdict: s.verdict,
                                signedDeviation: signed, deviationText: (deviation?.isEmpty ?? true) ? nil : deviation,
                                isEasy: easy, accessibilityLabel: spoken)
    }
}
