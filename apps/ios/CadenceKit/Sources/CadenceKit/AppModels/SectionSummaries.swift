import Foundation

/// One-line summaries shown in a collapsed section's header ("12 laps", "RPE 6 · Felt good",
/// the first line of a note), so a closed section still says what is inside.
public enum SectionSummary {
    /// "12 laps", "1 lap"; nil for zero.
    public static func count(_ n: Int, _ singular: String, plural: String? = nil) -> String? {
        guard n > 0 else { return nil }
        return "\(n) \(n == 1 ? singular : (plural ?? singular + "s"))"
    }

    /// "RPE 6 · Felt good · Note", or "Not logged yet".
    public static func log(rpe: Int?, feel: Int?, note: String?) -> String {
        var parts: [String] = []
        if let rpe { parts.append("RPE \(rpe)") }
        if let feel { parts.append("Felt \(EffortScale.feelLabel(feel).lowercased())") }
        if let note, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { parts.append("Note") }
        return parts.isEmpty ? "Not logged yet" : parts.joined(separator: Format.dot)
    }

    /// The first non-empty line of a text, cut at `limit` characters with an ellipsis; nil when empty.
    public static func firstLine(_ text: String?, limit: Int = 32) -> String? {
        guard let line = text?.split(whereSeparator: \.isNewline)
            .map({ $0.trimmingCharacters(in: .whitespaces) })
            .first(where: { !$0.isEmpty }) else { return nil }
        guard line.count > limit else { return line }
        return String(line.prefix(max(1, limit - 1))).trimmingCharacters(in: .whitespaces) + "\u{2026}"
    }
}

// Collapsed-header summaries of the Today sections.

extension FreshnessModel {
    /// "−2 neutral"
    public var summaryText: String {
        [formText, zoneWord].compactMap { $0 }.joined(separator: " ")
    }
}

extension WellnessModel {
    /// "HRV 61 · Resting HR 48 · Sleep 7:51" (metrics without a value are left out); nil when none.
    public var summaryText: String? {
        let parts = metrics.filter { $0.value != nil }.map { "\($0.label) \($0.valueText)" }
        return parts.isEmpty ? nil : parts.joined(separator: Format.dot)
    }
}

extension WeekStripModel {
    /// "7:48 of 9:45 planned"
    public var summaryText: String { "\(hoursText) \(plannedText)" }
}
