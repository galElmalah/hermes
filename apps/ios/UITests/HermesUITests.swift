import XCTest

/// End-to-end session checks against a real (local) Hermes server, through the app's debug-only
/// server override. Skipped unless configured:
///
///   HERMES_UITEST_SERVER_URL   e.g. http://127.0.0.1:5299 (what the app uses)
///   HERMES_UITEST_PASSPHRASE   e.g. hermes-demo
///   HERMES_UITEST_CONTROL_URL  optional: a switch in front of the server (GET /down, GET /up) to
///                              make it unreachable and reachable again (offline/recovery step)
///   HERMES_UITEST_SCREENSHOTS  optional: directory for PNG screenshots
///
/// With xcodebuild prefix each with TEST_RUNNER_ (e.g. TEST_RUNNER_HERMES_UITEST_SERVER_URL=…).
/// Start from a fresh install with an empty keychain (`xcrun simctl uninstall` + `simctl keychain reset`).
final class HermesUITests: XCTestCase {
    private var server = ""
    private var passphrase = ""
    private var control: String?
    private var shots: String?
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let s = env["HERMES_UITEST_SERVER_URL"], !s.isEmpty, let p = env["HERMES_UITEST_PASSPHRASE"], !p.isEmpty else {
            throw XCTSkip("set HERMES_UITEST_SERVER_URL and HERMES_UITEST_PASSPHRASE")
        }
        server = s; passphrase = p
        control = env["HERMES_UITEST_CONTROL_URL"].flatMap { $0.isEmpty ? nil : $0 }
        shots = env["HERMES_UITEST_SCREENSHOTS"].flatMap { $0.isEmpty ? nil : $0 }
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-HermesDebugServerURL", server]
    }

    /// (a) fresh install → server (pre-filled from the debug override) + passphrase · (b) sign in, data loads · (c) relaunch → still
    /// signed in, no prompt · (d) server unreachable → stays signed in with saved data, recovers on
    /// its own and on foregrounding · (e) device revoked on the server → back to the passphrase screen.
    func testSessionLifecycle() throws {
        let started = Date()
        if let control { try switchServer(control, "up") }  // a previous failed run may have left it down

        // (a)
        app.launch()
        let field = app.secureTextFields["passphrase"]
        XCTAssertTrue(field.waitForExistence(timeout: 15), "passphrase field")
        let serverField = app.textFields["server"]
        XCTAssertTrue(serverField.exists, "server address field")
        XCTAssertFalse((serverField.value as? String ?? "").isEmpty, "server pre-filled from the debug override")
        XCTAssertEqual(app.secureTextFields.count, 1)
        shot("a-fresh-install")

        // (b)
        field.tap()
        field.typeText(passphrase)
        app.buttons["sign-in"].tap()
        let todayTab = app.tabBars.buttons["Today"]
        XCTAssertTrue(todayTab.waitForExistence(timeout: 30), "signed in")
        XCTAssertTrue(app.navigationBars["Today"].waitForExistence(timeout: 10))
        waitForData()
        shot("b-signed-in")

        // (c)
        app.terminate()
        app.launch()
        // straight into the tabs: the passphrase screen must never appear
        XCTAssertTrue(todayTab.waitForExistence(timeout: 5))
        XCTAssertFalse(app.secureTextFields["passphrase"].exists)
        waitForData()
        XCTAssertFalse(app.secureTextFields["passphrase"].exists)
        shot("c-relaunched")

        // (d)
        if let control {
            try switchServer(control, "down")
            // d1: cold launch while the server is unreachable → signed in, saved data, quiet offline line
            app.terminate()
            app.launch()
            XCTAssertTrue(todayTab.waitForExistence(timeout: 5))
            XCTAssertTrue(offlineNotice.waitForExistence(timeout: 30), "offline notice with saved data")
            XCTAssertFalse(app.secureTextFields["passphrase"].exists, "offline must not sign out")
            shot("d1-offline-cold-launch")

            // d2: server back → recovers by itself (backoff retry), no user action
            try switchServer(control, "up")
            XCTAssertTrue(waitUntilGone(offlineNotice, timeout: 45), "recovered without user action")
            XCTAssertTrue(todayTab.exists)
            shot("d2-recovered-automatically")

            // d3: unreachable while in the background → foreground shows offline, still signed in
            try switchServer(control, "down")
            XCUIDevice.shared.press(.home)
            sleep(2)
            app.activate()
            XCTAssertTrue(offlineNotice.waitForExistence(timeout: 30), "offline after foregrounding")
            XCTAssertFalse(app.secureTextFields["passphrase"].exists)
            shot("d3-offline-after-foreground")

            // d4: server back, app backgrounded and foregrounded → recovered
            try switchServer(control, "up")
            XCUIDevice.shared.press(.home)
            sleep(2)
            app.activate()
            XCTAssertTrue(waitUntilGone(offlineNotice, timeout: 20), "recovered on foreground")
            XCTAssertFalse(app.secureTextFields["passphrase"].exists)
            shot("d4-recovered-on-foreground")
        }

        // (e) revoke this iPhone's device on the server with a separate token
        let revoked = try revokeAppDevices(createdAfter: started)
        XCTAssertGreaterThan(revoked, 0, "found the app's device on the server")
        XCUIDevice.shared.press(.home)
        sleep(2)
        app.activate()
        let again = app.secureTextFields["passphrase"]
        XCTAssertTrue(again.waitForExistence(timeout: 30), "401 → passphrase screen")
        XCTAssertEqual(app.textFields.count, 0, "still only the passphrase field")
        XCTAssertFalse(todayTab.exists)
        shot("e-revoked")
    }

    /// Activity charts and collapsible sections (needs HERMES_UITEST_ACTIVITY_ID: an activity with
    /// streams and at least two charts). A horizontal drag on a lower chart scrubs (the page does
    /// not move) and shows the in-chart label; a vertical swipe that starts on a chart scrolls.
    /// While a scrub is held the test writes `<screenshots>/scrub-holding-<name>` so a host script
    /// can grab a screenshot mid-gesture (XCUITest cannot screenshot during its own drag).
    func testChartScrubAndCollapsibleSections() throws {
        let env = ProcessInfo.processInfo.environment
        guard let activity = env["HERMES_UITEST_ACTIVITY_ID"], !activity.isEmpty else {
            throw XCTSkip("set HERMES_UITEST_ACTIVITY_ID")
        }
        app.launch()
        signInIfNeeded()

        app.open(URL(string: "hermes://activity/\(activity)")!)
        let primary = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'chart-'")).firstMatch
        XCTAssertTrue(primary.waitForExistence(timeout: 30), "charts loaded")
        shot("activity-top")

        // collapsed by default: secondary charts, laps, metrics
        let more = app.buttons["section-activity.moreCharts"]
        XCTAssertTrue(more.waitForExistence(timeout: 10))
        if (more.value as? String)?.hasPrefix("Collapsed") == false { more.tap() } // start closed
        XCTAssertTrue((more.value as? String)?.hasPrefix("Collapsed") ?? false, "More charts starts closed")
        scrollTo(more)
        shot("sections-collapsed")
        more.tap()
        XCTAssertTrue((more.value as? String)?.hasPrefix("Expanded") ?? false)
        let lower = app.descendants(matching: .any).matching(NSPredicate(format: "identifier IN %@", ["chart-heartRate", "chart-cadence"])).element(boundBy: 0)
        XCTAssertTrue(lower.waitForExistence(timeout: 5), "a secondary chart")
        scrollTo(lower, margin: 260)
        shot("sections-expanded")

        // vertical swipe starting on the chart scrolls the page
        let before = lower.frame.minY
        lower.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.01, thenDragTo: lower.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: -1.2)),
                   withVelocity: .fast, thenHoldForDuration: 0)
        sleep(1)
        XCTAssertLessThan(lower.frame.minY, before - 40, "vertical drag on a chart scrolls the page")
        scrollTo(lower, margin: 260)

        // horizontal drag on the lower chart scrubs; the page stays put
        let y = lower.frame.minY
        scrub(lower, name: "lower-chart")
        XCTAssertEqual(lower.frame.minY, y, accuracy: 2, "horizontal drag does not scroll")

        // Trends: fitness chart label
        app.tabBars.buttons["Trends"].tap()
        let fitness = app.descendants(matching: .any)["chart-fitness"]
        XCTAssertTrue(fitness.waitForExistence(timeout: 30))
        scrollTo(fitness, margin: 200)
        scrub(fitness, name: "trends-fitness")
        shot("trends-sections")
    }

    /// The Execution section (needs HERMES_UITEST_EXECUTION_ACTIVITY_ID: an activity whose detail
    /// carries `execution`): open by default with score + steps, and it collapses to one line.
    func testExecutionSection() throws {
        let env = ProcessInfo.processInfo.environment
        guard let activity = env["HERMES_UITEST_EXECUTION_ACTIVITY_ID"], !activity.isEmpty else {
            throw XCTSkip("set HERMES_UITEST_EXECUTION_ACTIVITY_ID")
        }
        app.launch()
        signInIfNeeded()
        app.open(URL(string: "hermes://activity/\(activity)")!)
        let header = app.buttons["section-activity.execution"]
        XCTAssertTrue(header.waitForExistence(timeout: 30), "execution section shown")
        XCTAssertTrue((header.value as? String)?.hasPrefix("Expanded") ?? false, "open by default")
        shot("execution-top")
        app.swipeUp(velocity: .slow)
        shot("execution-steps")
        scrollTo(header)
        header.tap()
        XCTAssertTrue((header.value as? String)?.hasPrefix("Collapsed") ?? false)
        shot("execution-collapsed")
        header.tap() // leave it open for the next run
    }

    private func signInIfNeeded() {
        let field = app.secureTextFields["passphrase"]
        let todayTab = app.tabBars.buttons["Today"]
        if field.waitForExistence(timeout: 8) {
            field.tap()
            field.typeText(passphrase)
            app.buttons["sign-in"].tap()
        }
        XCTAssertTrue(todayTab.waitForExistence(timeout: 30), "signed in")
    }

    /// Swipes the page until `element` sits in the upper part of the screen.
    private func scrollTo(_ element: XCUIElement, margin: CGFloat = 160) {
        let window = app.windows.firstMatch.frame
        for _ in 0..<12 where element.frame.maxY > window.maxY - margin || !element.isHittable {
            app.swipeUp(velocity: .slow)
        }
    }

    /// Press, drag sideways and hold; announces the hold for a host-side screenshot, then shoots
    /// the end state (still pressed is not possible from XCUITest).
    private func scrub(_ chart: XCUIElement, name: String) {
        if let shots {
            let marker = URL(fileURLWithPath: shots).appendingPathComponent("scrub-holding-\(name)")
            try? FileManager.default.createDirectory(atPath: shots, withIntermediateDirectories: true)
            try? Data(Date().description.utf8).write(to: marker)
        }
        let from = chart.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.6))
        let to = chart.coordinate(withNormalizedOffset: CGVector(dx: 0.78, dy: 0.6))
        from.press(forDuration: 0.02, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 6)
    }

    // MARK: Helpers

    private var offlineNotice: XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Offline'")).firstMatch
    }

    /// Today has loaded something from the server (the session list or its empty state).
    private func waitForData() {
        let loading = app.activityIndicators.firstMatch
        _ = waitUntilGone(loading, timeout: 20)
        XCTAssertFalse(app.staticTexts["Couldn\u{2019}t load this"].exists)
        XCTAssertFalse(offlineNotice.exists)
    }

    private func waitUntilGone(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element)
        return XCTWaiter().wait(for: [gone], timeout: timeout) == .completed
    }

    private func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let attachment = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let shots {
            try? FileManager.default.createDirectory(atPath: shots, withIntermediateDirectories: true)
            try? png.write(to: URL(fileURLWithPath: shots).appendingPathComponent("\(name).png"))
        }
    }

    private func switchServer(_ control: String, _ state: String) throws {
        _ = try request("GET", URL(string: control + "/" + state)!)
    }

    /// Creates a helper device with the passphrase, revokes every iOS device created since the test
    /// started except itself (= the app's), then revokes the helper. Returns how many were revoked.
    private func revokeAppDevices(createdAfter start: Date) throws -> Int {
        let base = URL(string: server)!
        let body = try JSONSerialization.data(withJSONObject: ["passphrase": passphrase, "name": "UI test helper", "platform": "other"])
        let (created, _) = try request("POST", base.appendingPathComponent("api/auth/devices"), body: body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: created) as? [String: Any])
        let token = try XCTUnwrap(json["token"] as? String)
        let helper = (json["device"] as? [String: Any])?["id"] as? String
        let auth = ["Authorization": "Bearer \(token)"]
        let (list, _) = try request("GET", base.appendingPathComponent("api/auth/devices"), headers: auth)
        let devices = (try JSONSerialization.jsonObject(with: list) as? [String: Any])?["devices"] as? [[String: Any]] ?? []
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var count = 0
        for d in devices {
            guard let id = d["id"] as? String, id != helper, d["platform"] as? String == "ios",
                  let createdAt = (d["createdAt"] as? String).flatMap(iso.date(from:)),
                  createdAt >= start.addingTimeInterval(-5) else { continue }
            let (_, status) = try request("DELETE", base.appendingPathComponent("api/auth/devices/\(id)"), headers: auth)
            XCTAssertEqual(status, 204)
            count += 1
        }
        _ = try request("DELETE", base.appendingPathComponent("api/auth/devices/current"), headers: auth)
        return count
    }

    @discardableResult
    private func request(_ method: String, _ url: URL, body: Data? = nil, headers: [String: String] = [:]) throws -> (Data, Int) {
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = method
        req.httpBody = body
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        var result: (Data, Int)?
        var failure: Error?
        let done = expectation(description: "\(method) \(url.path)")
        URLSession.shared.dataTask(with: req) { data, response, error in
            if let error { failure = error } else { result = (data ?? Data(), (response as? HTTPURLResponse)?.statusCode ?? 0) }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 30)
        if let failure { throw failure }
        return try XCTUnwrap(result)
    }
}
