import XCTest
@testable import CadenceKit

/// `ExecutionAnalysis` (docs/MOBILE_API.md §4) decoding — strict fixtures and lenient edge cases —
/// and the Execution section's view-model.
final class ExecutionDecodingTests: XCTestCase {
    private func decode(_ json: String) throws -> ExecutionAnalysis {
        try APIClient.decode(ExecutionAnalysis.self, from: Data(json.utf8))
    }

    func testDocumentedExampleDecodes() throws {
        let e = try Fixtures.decode(ExecutionAnalysis.self, "execution_doc_example")
        XCTAssertTrue(e.isUsable)
        XCTAssertEqual(e.version, 1)
        XCTAssertEqual(e.method, .streams)
        XCTAssertEqual(e.confidence, .medium)
        XCTAssertEqual(e.score, 58)
        XCTAssertEqual(e.state, .partialShort)
        XCTAssertEqual(e.counts, ExecutionCounts(planned: 12, onTarget: 1, over: 2, under: 9, skipped: 0, extra: 1))
        XCTAssertEqual(e.planned.durationSec, 3300)
        XCTAssertEqual(e.actual.load, 103)
        XCTAssertEqual(e.steps.map(\.verdict), [.extra, .onTarget, .under, .over, .skipped])
        let extra = e.steps[0]
        XCTAssertNil(extra.plannedIndex)
        XCTAssertNil(extra.planned)
        XCTAssertNil(extra.role)
        XCTAssertNil(extra.score)
        let rep = e.steps[2]
        XCTAssertEqual(rep.role, .active)
        XCTAssertEqual(rep.repeat, ExecutionRepeat(iteration: 1, count: 5))
        XCTAssertEqual(rep.planned?.measure, .time)
        XCTAssertEqual(rep.planned?.target?.metric, .speed)
        XCTAssertEqual(rep.planned?.target?.text, "5:00/km")
        XCTAssertEqual(rep.intensity?.deltaPaceSec, -22)
        XCTAssertEqual(rep.intensity?.verdict, .under)
        XCTAssertEqual(rep.duration?.verdict, .long)
        XCTAssertEqual(rep.actual?.startSec, 1920)
        XCTAssertNil(e.steps[4].actual, "skipped: no actual")
    }

    func testSessionLevelAnalysisHasNoSteps() throws {
        let e = try Fixtures.decode(ExecutionAnalysis.self, "execution_session")
        XCTAssertEqual(e.method, .session)
        XCTAssertTrue(e.steps.isEmpty)
        XCTAssertTrue(e.isUsable)
    }

    func testUnknownValuesAndFieldsDoNotFail() throws {
        let e = try decode("""
        { "version": 2, "workoutId": "w", "activityId": "a", "method": "magic", "confidence": "certain",
          "note": "n", "score": 71, "state": "brand_new_state", "summary": "s", "futureField": {"x": 1},
          "counts": { "planned": 1, "onTarget": 0, "over": 0, "under": 0, "skipped": 0, "extra": 0, "partial": 3 },
          "planned": { "durationSec": null, "distanceM": null, "load": null },
          "actual": { "durationSec": 60, "distanceM": null, "load": null },
          "steps": [
            { "plannedIndex": 0, "stepId": "s1", "role": "sprint", "label": "Rep", "repeat": null, "weight": 1,
              "planned": { "measure": "strokes", "durationSec": 60, "distanceM": null,
                           "target": { "metric": "lactate", "low": 1, "high": 2, "plannedLow": 1, "plannedHigh": 2, "text": "2 mmol" },
                           "targetText": "2 mmol" },
              "actual": { "startSec": 0, "endSec": 60, "durationSec": 60, "distanceM": null, "avgSpeedMps": null,
                          "avgHr": 150, "avgPower": null, "avgCadence": null, "avgLactate": 2.2 },
              "intensity": { "metric": "lactate", "actual": 2.2, "delta": 0.2, "deltaPct": 0.1, "inTargetPct": null, "verdict": "way_over" },
              "duration": { "basis": "strokes", "planned": 60, "actual": 60, "delta": 0, "verdict": "perfect" },
              "verdict": "overcooked", "deviation": "something new", "score": 50 }
          ] }
        """)
        XCTAssertTrue(e.isUsable)
        XCTAssertEqual(e.method, .unknown)
        XCTAssertEqual(e.confidence, .unknown)
        XCTAssertEqual(e.state, .unknown)
        XCTAssertEqual(e.steps.count, 1)
        let s = e.steps[0]
        XCTAssertEqual(s.verdict, .unknown)
        XCTAssertEqual(s.role, .unknown)
        XCTAssertEqual(s.planned?.measure, .unknown)
        XCTAssertEqual(s.planned?.target?.metric, .unknown)
        XCTAssertEqual(s.intensity?.verdict, .unknown)
        XCTAssertEqual(s.duration?.verdict, .unknown)
        XCTAssertEqual(s.duration?.basis, .unknown)
        // and the view-model still builds
        let m = try XCTUnwrap(ExecutionModel(e, sport: .run, units: .metric))
        XCTAssertEqual(m.steps.first?.verdict, .unknown)
        XCTAssertEqual(m.steps.first?.label, "Rep")
        XCTAssertEqual(m.stateLabel, "Done")
    }

    func testMalformedPartsAreDroppedNotFatal() throws {
        let e = try decode("""
        { "score": "high", "summary": 3, "counts": "none", "steps": [ 42, { "label": "Ok", "verdict": "over", "score": 10 },
          { "label": ["bad"], "verdict": "under" }, null ] }
        """)
        XCTAssertNil(e.score, "a non-numeric score is not usable")
        XCTAssertFalse(e.isUsable)
        XCTAssertEqual(e.summary, "")
        XCTAssertEqual(e.counts, ExecutionCounts())
        XCTAssertEqual(e.steps.map(\.verdict), [.over, .under], "bad steps dropped, bad fields defaulted")
        XCTAssertEqual(e.steps[1].label, "")
        XCTAssertNil(ExecutionModel(e, sport: .run, units: .metric), "no score: the section is hidden")
    }

    func testNotAnObjectDecodesAsUnusable() throws {
        XCTAssertFalse(try decode("\"oops\"").isUsable)
        XCTAssertFalse(try decode("[]").isUsable)
    }

    private func activityJSON(adding execution: Any?) throws -> Data {
        var obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Fixtures.data("activity_run")) as? [String: Any])
        if let execution { obj["execution"] = execution } else { obj.removeValue(forKey: "execution") }
        return try JSONSerialization.data(withJSONObject: obj)
    }

    func testActivityDetailCarriesExecution() throws {
        let example = try JSONSerialization.jsonObject(with: Fixtures.data("execution_doc_example"))
        let d = try APIClient.decode(ActivityDetail.self, from: activityJSON(adding: example))
        XCTAssertEqual(d.execution?.score, 58)
        let vm = ActivityDetailModel(detail: d, units: .metric)
        XCTAssertEqual(vm.execution?.scoreText, "58")
    }

    func testActivityWithoutOrWithBrokenExecutionStillDecodes() throws {
        let none = try APIClient.decode(ActivityDetail.self, from: activityJSON(adding: nil))
        XCTAssertNil(none.execution)
        XCTAssertNil(ActivityDetailModel(detail: none, units: .metric).execution, "hidden without analysis")
        let broken = try APIClient.decode(ActivityDetail.self, from: activityJSON(adding: "not an object"))
        XCTAssertNil(ActivityDetailModel(detail: broken, units: .metric).execution)
        XCTAssertEqual(broken.id, none.id)
    }

    func testWorkoutCarriesExecutionAndComplianceScore() throws {
        var obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Fixtures.data("workout_structured")) as? [String: Any])
        obj["execution"] = try JSONSerialization.jsonObject(with: Fixtures.data("execution_session"))
        obj["compliance"] = ["metric": "duration", "ratio": 1.02, "state": "on_target", "score": 96]
        let w = try APIClient.decode(PlannedWorkout.self, from: JSONSerialization.data(withJSONObject: obj))
        XCTAssertEqual(w.compliance?.score, 96)
        XCTAssertEqual(w.execution?.method, .session)
        let m = WorkoutScreenModel.build(w, units: .metric, today: w.date)
        XCTAssertEqual(m.execution?.scoreText, "100")
        XCTAssertEqual(m.execution?.steps.count, 0)
        obj["execution"] = ["steps": 7]
        let broken = try APIClient.decode(PlannedWorkout.self, from: JSONSerialization.data(withJSONObject: obj))
        XCTAssertNil(WorkoutScreenModel.build(broken, units: .metric, today: w.date).execution)
    }
}

final class ExecutionModelTests: XCTestCase {
    private func model() throws -> ExecutionModel {
        let e = try Fixtures.decode(ExecutionAnalysis.self, "execution_doc_example")
        return try XCTUnwrap(ExecutionModel(e, sport: .run, units: .metric))
    }

    func testHeadline() throws {
        let m = try model()
        XCTAssertEqual(m.score, 58)
        XCTAssertEqual(m.scoreText, "58")
        XCTAssertEqual(m.stateLabel, "Short")
        XCTAssertEqual(m.tone, .warn)
        XCTAssertEqual(m.countsText, "1 on target\(Format.dot)2 over\(Format.dot)9 under\(Format.dot)1 extra")
        XCTAssertEqual(m.totalsText, "Planned 55:00\(Format.dot)8.62\u{202F}km \u{2192} done 59:18\(Format.dot)8.46\u{202F}km"
            .replacingOccurrences(of: "8.62", with: Format.distance(8619, sport: .run).components(separatedBy: "\u{202F}")[0])
            .replacingOccurrences(of: "8.46", with: Format.distance(8460, sport: .run).components(separatedBy: "\u{202F}")[0]))
        XCTAssertEqual(m.methodText, "Laps don't line up with the plan's 12 steps; aligned on the pace stream\(Format.dot)medium confidence")
        XCTAssertTrue(m.accessibilityLabel.hasPrefix("Adherence 58 out of 100, short."))
    }

    func testStepRowsShowPlannedVsActualVerdictAndSignedDeviation() throws {
        let rows = try model().steps
        XCTAssertEqual(rows.map(\.label), ["Extra", "Warm-up", "Rep 1 of 5", "Rep 2 of 5", "Cool-down"])

        let extra = rows[0]
        XCTAssertNil(extra.plannedText)
        XCTAssertEqual(extra.actualText, "9:00\(Format.dot)131\u{202F}bpm")
        XCTAssertNil(extra.signedDeviation)
        XCTAssertEqual(extra.deviationText, "9:00 not in the plan")

        let warm = rows[1]
        XCTAssertEqual(warm.verdict, .onTarget)
        XCTAssertNil(warm.signedDeviation)
        XCTAssertTrue(warm.isEasy)

        let under = rows[2]
        XCTAssertEqual(under.plannedText, "4:00\(Format.dot)5:00/km")
        XCTAssertEqual(under.actualText, "5:00\(Format.dot)5:23\u{202F}/km")
        XCTAssertEqual(under.signedDeviation, "\u{2212}22 s/km", "slower = negative")
        XCTAssertEqual(under.deviationText, "22 s/km slower than target · 1:00 long")
        XCTAssertFalse(under.isEasy)

        let over = rows[3]
        XCTAssertEqual(over.verdict, .over)
        XCTAssertEqual(over.signedDeviation, "+12 s/km", "faster = positive")
        XCTAssertNotEqual(ExecutionVerdict.over.symbol, ExecutionVerdict.under.symbol, "over/under differ beyond colour")
        XCTAssertNotEqual(ExecutionVerdict.over.label, ExecutionVerdict.under.label)

        let skipped = rows[4]
        XCTAssertEqual(skipped.verdict, .skipped)
        XCTAssertNil(skipped.actualText)
        XCTAssertEqual(skipped.plannedText, "10:00\(Format.dot)easy")
        XCTAssertTrue(skipped.accessibilityLabel.hasPrefix("Cool-down: skipped"))
    }

    func testPowerAndDurationDeviations() {
        let power = ExecutionStep(label: "Interval", planned: ExecutionPlannedStep(measure: .time, durationSec: 600,
                                  target: ExecutionTarget(metric: .power, text: "238–250 W")),
                                  actual: ExecutionActualStep(durationSec: 600, avgPower: 262),
                                  intensity: ExecutionIntensity(metric: .power, actual: 262, delta: 12, deltaPct: 0.048, verdict: .over),
                                  verdict: .over)
        let r = ExecutionModel.row(power, index: 0, sport: .bike, units: .metric)
        XCTAssertEqual(r.signedDeviation, "+5%")
        XCTAssertEqual(r.actualText, "10:00\(Format.dot)262\u{202F}W")

        let short = ExecutionStep(label: "Rep", planned: ExecutionPlannedStep(measure: .distance, distanceM: 1000),
                                  actual: ExecutionActualStep(durationSec: 200, distanceM: 800),
                                  duration: ExecutionDuration(basis: .distance, planned: 1000, actual: 800, delta: -200, verdict: .short),
                                  verdict: .under)
        let s = ExecutionModel.row(short, index: 1, sport: .run, units: .metric)
        XCTAssertEqual(s.signedDeviation, "\u{2212}" + Format.distance(200, sport: .run))
        XCTAssertEqual(s.plannedText, Format.distance(1000, sport: .run))
        XCTAssertEqual(s.actualText, Format.distance(800, sport: .run))

        let long = ExecutionStep(label: "Easy", planned: ExecutionPlannedStep(measure: .time, durationSec: 600),
                                 actual: ExecutionActualStep(durationSec: 700),
                                 duration: ExecutionDuration(basis: .time, planned: 600, actual: 700, delta: 100, verdict: .long),
                                 verdict: .over)
        XCTAssertEqual(ExecutionModel.row(long, index: 2, sport: .run, units: .metric).signedDeviation, "+1:40")
    }

    func testScoreIsClamped() {
        let e = ExecutionAnalysis(score: 140, state: .onTarget)
        XCTAssertEqual(ExecutionModel(e, sport: .run, units: .metric)?.score, 100)
        XCTAssertNil(ExecutionModel(nil, sport: .run, units: .metric))
        XCTAssertNil(ExecutionModel(ExecutionAnalysis(score: .nan), sport: .run, units: .metric))
    }
}
