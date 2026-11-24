import XCTest
@testable import CadenceKit

final class SectionStateStoreTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suite = "SectionStateStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func testEssentialsOpenDetailsClosedByDefault() {
        let store = SectionStateStore(defaults: defaults)
        for open in [DetailSection.activityExecution, .workoutExecution, .workoutProfile, .todayForm, .weekDays] {
            XCTAssertTrue(store.isExpanded(open), open.rawValue)
        }
        for closed in [DetailSection.activityLaps, .activityZones, .activityPeaks, .activityMoreCharts, .activityMetrics,
                       .activityLog, .workoutAbout, .workoutNotes, .todayNote, .trendsVolume, .weekNote, .weekHighlights] {
            XCTAssertFalse(store.isExpanded(closed), closed.rawValue)
        }
    }

    func testRemembersPerSectionAcrossInstances() {
        let a = SectionStateStore(defaults: defaults)
        a.setExpanded(true, for: .activityLaps)
        a.setExpanded(false, for: .activityExecution)
        let b = SectionStateStore(defaults: defaults)
        XCTAssertTrue(b.isExpanded(.activityLaps))
        XCTAssertFalse(b.isExpanded(.activityExecution))
        XCTAssertFalse(b.isExpanded(.activityZones), "other sections untouched")
        XCTAssertEqual(defaults.object(forKey: "hermes.section.activity.laps") as? Bool, true)
    }

    func testExplicitFallbackOnlyWhenNothingStored() {
        let store = SectionStateStore(defaults: defaults)
        XCTAssertFalse(store.isExpanded(.workoutSteps, default: false))
        store.setExpanded(true, for: .workoutSteps)
        XCTAssertTrue(store.isExpanded(.workoutSteps, default: false), "the remembered choice wins")
    }

    func testToggleAndReset() {
        let store = SectionStateStore(defaults: defaults)
        XCTAssertTrue(store.toggle(.trendsVolume))
        XCTAssertFalse(store.toggle(.trendsVolume))
        XCTAssertFalse(store.toggle(.todayForm), "toggling a default-open section closes it")
        store.resetAll()
        XCTAssertTrue(store.isExpanded(.todayForm))
        XCTAssertNil(defaults.object(forKey: SectionStateStore.key(.trendsVolume)))
    }

    func testKeysAreUnique() {
        XCTAssertEqual(Set(DetailSection.allCases.map(\.rawValue)).count, DetailSection.allCases.count)
    }
}

final class SectionSummaryTests: XCTestCase {
    func testCount() {
        XCTAssertNil(SectionSummary.count(0, "lap"))
        XCTAssertEqual(SectionSummary.count(1, "lap"), "1 lap")
        XCTAssertEqual(SectionSummary.count(12, "lap"), "12 laps")
        XCTAssertEqual(SectionSummary.count(3, "best effort"), "3 best efforts")
    }

    func testLog() {
        XCTAssertEqual(SectionSummary.log(rpe: nil, feel: nil, note: "  "), "Not logged yet")
        XCTAssertEqual(SectionSummary.log(rpe: 6, feel: 4, note: nil), "RPE 6\(Format.dot)Felt good")
        XCTAssertEqual(SectionSummary.log(rpe: nil, feel: nil, note: "legs heavy"), "Note")
    }

    func testFirstLine() {
        XCTAssertNil(SectionSummary.firstLine(nil))
        XCTAssertNil(SectionSummary.firstLine("\n  \n"))
        XCTAssertEqual(SectionSummary.firstLine("\nBring gels\nand a jacket"), "Bring gels")
        XCTAssertEqual(SectionSummary.firstLine("abcdefghij", limit: 5), "abcd\u{2026}")
    }
}

final class TodaySummaryTests: XCTestCase {
    func testWellnessSummarySkipsMissingValues() {
        let m = WellnessModel(metrics: [
            WellnessMetric(label: "HRV", value: 61, valueText: "61", unit: "ms", context: nil),
            WellnessMetric(label: "Resting HR", value: nil, valueText: "\u{2014}", unit: "bpm", context: nil),
            WellnessMetric(label: "Sleep", value: 28_260, valueText: "7:51", unit: "h", context: nil),
        ], reasonsText: nil, feel: nil, soreness: nil, feelLabels: [], sorenessLabels: [], showsSoreness: false)
        XCTAssertEqual(m.summaryText, "HRV 61\(Format.dot)Sleep 7:51")
        var empty = m
        empty.metrics = []
        XCTAssertNil(empty.summaryText)
    }
}
