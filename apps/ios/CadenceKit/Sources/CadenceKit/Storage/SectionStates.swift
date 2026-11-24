import Foundation

// Collapsible detail sections: which sections exist, which are open by default (essentials open,
// details closed), and the remembered open/closed state per section in the App Group defaults.
// The state is per section, not per activity/workout ("laps" stays closed on every activity once
// closed). It is a display preference, not account data, so sign-out keeps it.

/// Every collapsible section of the app, with its default. Raw values are the storage keys.
public enum DetailSection: String, CaseIterable, Hashable, Sendable {
    // Activity
    case activityExecution = "activity.execution"
    case activityMap = "activity.map"
    case activityMoreCharts = "activity.moreCharts"
    case activityMetrics = "activity.metrics"
    case activityLaps = "activity.laps"
    case activityZones = "activity.zones"
    case activityPeaks = "activity.peaks"
    case activityExercises = "activity.exercises"
    case activityLog = "activity.log"
    // Workout
    case workoutExecution = "workout.execution"
    case workoutProfile = "workout.profile"
    case workoutSteps = "workout.steps"
    case workoutAbout = "workout.about"
    case workoutNotes = "workout.notes"
    // Today
    case todayForm = "today.form"
    case todayWellness = "today.wellness"
    case todayWeek = "today.week"
    case todayUpNext = "today.upNext"
    case todayNote = "today.note"
    // Trends
    case trendsVolume = "trends.volume"
    case trendsProgression = "trends.progression"
    case trendsIntensity = "trends.intensity"
    case trendsConsistency = "trends.consistency"
    // Week review
    case weekDays = "week.days"
    case weekBySport = "week.bySport"
    case weekKeySessions = "week.keySessions"
    case weekIntensity = "week.intensity"
    case weekHighlights = "week.highlights"
    case weekNote = "week.note"

    /// Essentials (headline numbers, the execution summary, the first chart, what the page is
    /// for) start open; secondary detail (laps, zones, peaks, notes, metadata, secondary charts)
    /// starts closed.
    public var defaultExpanded: Bool {
        switch self {
        case .activityExecution, .activityMap, .activityExercises,
             .workoutExecution, .workoutProfile, .workoutSteps,
             .todayForm,
             .weekDays:
            return true
        default:
            return false
        }
    }
}

/// Remembered open/closed state of the collapsible sections (UserDefaults; the app passes the App
/// Group suite). Unset sections use their default.
public final class SectionStateStore: @unchecked Sendable {
    public static let keyPrefix = "hermes.section."

    public let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public static func key(_ section: DetailSection) -> String { keyPrefix + section.rawValue }

    /// The remembered state, else `fallback`, else the section's own default.
    public func isExpanded(_ section: DetailSection, default fallback: Bool? = nil) -> Bool {
        if let stored = defaults.object(forKey: SectionStateStore.key(section)) as? Bool { return stored }
        return fallback ?? section.defaultExpanded
    }

    public func setExpanded(_ expanded: Bool, for section: DetailSection) {
        defaults.set(expanded, forKey: SectionStateStore.key(section))
    }

    /// Flips the section and returns the new state.
    @discardableResult
    public func toggle(_ section: DetailSection, default fallback: Bool? = nil) -> Bool {
        let next = !isExpanded(section, default: fallback)
        setExpanded(next, for: section)
        return next
    }

    /// Forgets every remembered state (all sections back to their defaults).
    public func resetAll() {
        for section in DetailSection.allCases {
            defaults.removeObject(forKey: SectionStateStore.key(section))
        }
    }
}
