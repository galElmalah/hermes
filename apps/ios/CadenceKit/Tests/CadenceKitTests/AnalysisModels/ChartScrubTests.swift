import XCTest
@testable import CadenceKit

final class ScrubLabelPlacementTests: XCTestCase {
    private func place(_ anchorX: Double, finger: Double? = nil, w: Double = 80, h: Double = 34,
                       bw: Double = 300, bh: Double = 96) -> ScrubLabelPlacement {
        ScrubLabelPlacement.place(anchorX: anchorX, fingerY: finger, labelWidth: w, labelHeight: h,
                                  boundsWidth: bw, boundsHeight: bh, gap: 8, fingerClearance: 26)
    }

    func testRightOfTheRuleAtTheTopByDefault() {
        let p = place(100)
        XCTAssertEqual(p.side, .trailing)
        XCTAssertEqual(p.x, 108)
        XCTAssertEqual(p.y, 0)
    }

    func testFlipsLeftNearTheRightEdge() {
        let p = place(250)
        XCTAssertEqual(p.side, .leading)
        XCTAssertEqual(p.x, 250 - 8 - 80)
        XCTAssertLessThanOrEqual(p.x + 80, 300)
    }

    func testStaysRightNearTheLeftEdge() {
        let p = place(0)
        XCTAssertEqual(p.side, .trailing)
        XCTAssertEqual(p.x, 8)
    }

    func testClampedInsideWhenNeitherSideFits() {
        // 200 wide label in a 240 plot: near the edges one side still fits
        let right = place(230, w: 200, bw: 240)
        XCTAssertEqual(right.x, 22)
        XCTAssertEqual(right.side, .leading)
        let left = place(10, w: 200, bw: 240)
        XCTAssertEqual(left.x, 18)
        XCTAssertEqual(left.side, .trailing)
        // in the middle neither side has 208 pt: the roomier side, clamped inside the plot
        let midRight = place(120, w: 200, bw: 240)
        XCTAssertEqual(midRight.x, 0)
        XCTAssertEqual(midRight.side, .leading)
        let midLeft = place(100, w: 200, bw: 240)
        XCTAssertEqual(midLeft.x, 40)
        XCTAssertEqual(midLeft.side, .trailing)
    }

    func testLabelWiderThanThePlotIsPinnedToTheLeft() {
        let p = place(150, w: 400, bw: 300)
        XCTAssertEqual(p.x, 0)
    }

    func testAnchorOutsideThePlotIsClamped() {
        let p = place(-40)
        XCTAssertEqual(p.x, 8)
        let q = place(500)
        XCTAssertEqual(q.x, 300 - 8 - 80)
    }

    func testFingerInTheLabelBandPushesTheLabelSideways() {
        let p = place(100, finger: 20)
        XCTAssertEqual(p.x, 126, "clear of a fingertip near the top")
        XCTAssertEqual(p.y, 0)
        let flipped = place(250, finger: 20)
        XCTAssertEqual(flipped.x, 250 - 26 - 80)
    }

    func testFingerBelowTheLabelKeepsItAboveTheFinger() {
        let p = place(100, finger: 80)
        XCTAssertEqual(p.x, 108)
        XCTAssertEqual(p.y, 0)
        XCTAssertLessThan(p.y + 34, 80, "the label ends above the fingertip")
    }

    func testLabelTallerThanThePlotStaysInside() {
        let p = place(100, h: 200, bh: 96)
        XCTAssertEqual(p.y, 0)
    }
}

final class NearestSampleTests: XCTestCase {
    func testNearestValueSkipsMissingSamples() {
        let xs: [Double] = [0, 1, 2, 3, 4, 5]
        let v: [Double?] = [10, nil, nil, 13, nil, 15]
        XCTAssertEqual(ChartMath.nearestValueIndex(xs, v, to: 0.2, maxDistance: 5), 0)
        XCTAssertEqual(ChartMath.nearestValueIndex(xs, v, to: 2.2, maxDistance: 5), 3, "the nearer of 0 and 3")
        XCTAssertEqual(ChartMath.nearestValueIndex(xs, v, to: 1.4, maxDistance: 5), 0)
        XCTAssertEqual(ChartMath.nearestValueIndex(xs, v, to: 4, maxDistance: 5), 3, "ties go left")
    }

    func testNearestValueRespectsReach() {
        let xs: [Double] = [0, 10, 20, 30]
        let v: [Double?] = [1, nil, nil, 4]
        XCTAssertNil(ChartMath.nearestValueIndex(xs, v, to: 15, maxDistance: 5))
        XCTAssertEqual(ChartMath.nearestValueIndex(xs, v, to: 15, maxDistance: 15), 0)
        XCTAssertNil(ChartMath.nearestValueIndex([], [], to: 1, maxDistance: 10))
        XCTAssertNil(ChartMath.nearestValueIndex(xs, [nil, nil, nil, nil], to: 1, maxDistance: 100))
    }

    func testNearestValueToleratesMismatchedLengths() {
        XCTAssertEqual(ChartMath.nearestValueIndex([0, 1, 2], [5], to: 2, maxDistance: 10), 0)
    }
}

final class StreamScrubLabelTests: XCTestCase {
    private func ride() -> ActivityStreams {
        let t = (0..<3600).map(Double.init)
        var hr: [Double?] = t.map { 120 + 20 * sin($0 / 300) }
        for i in 1000..<1003 { hr[i] = nil }      // a short dropout
        for i in 2000..<2400 { hr[i] = nil }      // strap off for a while
        return ActivityStreams(t: t, hr: hr, power: t.map { 200 + 50 * sin($0 / 60) }, speed: t.map { _ in 9.0 },
                               cadence: t.map { _ in 88 }, altitude: t.map { 100 + $0 / 36 }, distance: t.map { $0 * 9 })
    }

    func testPowerLabelHasValueUnitAndPosition() throws {
        let m = StreamChartModel(streams: ride(), sport: .bike, units: .metric)
        let l = try XCTUnwrap(m.scrubLabel(.power, at: 1800.3))
        XCTAssertEqual(l.x, 1800, "snapped to the nearest sample")
        XCTAssertEqual(l.items.map(\.value), [Format.number(200 + 50 * sin(1800.0 / 60))])
        XCTAssertEqual(l.items.first?.unit, "W")
        XCTAssertEqual(l.position, "30:00\(Format.dot)16.2\u{202F}km")
        XCTAssertNotNil(l.plotY)
    }

    func testSiblingTracksShareTheSameX() {
        let m = StreamChartModel(streams: ride(), sport: .bike, units: .metric)
        let xs = [StreamMetric.power, .heartRate, .cadence, .elevation].compactMap { m.scrubLabel($0, at: 754.6)?.x }
        XCTAssertEqual(xs, [755, 755, 755, 755])
        XCTAssertEqual(m.scrubLabel(.elevation, at: 754.6)?.items.first?.unit, "m")
    }

    func testShortDropoutUsesTheNearestValueLongGapShowsNothing() {
        let m = StreamChartModel(streams: ride(), sport: .bike, units: .metric)
        let near = m.scrubLabel(.heartRate, at: 1001)
        XCTAssertNotNil(near, "a 3 s dropout borrows the neighbouring sample")
        XCTAssertEqual(near?.items.first?.unit, "bpm")
        XCTAssertNil(m.scrubLabel(.heartRate, at: 2200), "no heart rate while the strap was off")
        XCTAssertNil(m.scrubLabel(.speed, at: 100), "speed is not a track next to power")
    }

    func testPaceLabelIsFormattedAsPace() {
        let t = (0..<600).map(Double.init)
        let m = StreamChartModel(streams: ActivityStreams(t: t, speed: t.map { _ in 4.0 }), sport: .run, units: .metric)
        let l = m.scrubLabel(.pace, at: 300)
        XCTAssertEqual(l?.items.first?.value, "4:10")
        XCTAssertEqual(l?.items.first?.unit, "/km")
        XCTAssertEqual(l?.position, "5:00", "no distance stream: time only")
        XCTAssertLessThan(l?.plotY ?? 0, 0, "pace is plotted negative")
    }

    func testTrendScrubLabels() throws {
        let days = [
            FitnessDay(date: "2026-11-20", load: 50, plannedLoad: 0, fitness: 60, fatigue: 70, form: -10, formPct: nil, formZone: .neutral, ramp: nil, projected: false),
            FitnessDay(date: "2026-11-21", load: 40, plannedLoad: 0, fitness: 61, fatigue: 68, form: -7, formPct: nil, formZone: .neutral, ramp: nil, projected: false),
            FitnessDay(date: "2026-11-22", load: 0, plannedLoad: 60, fitness: 60, fatigue: 60, form: 0, formPct: nil, formZone: .neutral, ramp: nil, projected: true),
        ]
        let fitness = FitnessTrend(from: days.first!.date, to: days.last!.date, today: "2026-11-21", days: days, events: [], phases: [], thresholdChanges: [])
        let chart = FitnessChartModel(trend: fitness, range: .sixWeeks)
        let x = try XCTUnwrap(Day("2026-11-22")).chartX
        let l = try XCTUnwrap(chart.scrubLabel(at: x - 0.2))
        XCTAssertEqual(l.x, x)
        XCTAssertEqual(l.items.map(\.text), ["Fitness 60", "Fatigue 60", "Form " + Format.form(0)])
        XCTAssertTrue(l.position.hasSuffix("planned"))
    }
}
