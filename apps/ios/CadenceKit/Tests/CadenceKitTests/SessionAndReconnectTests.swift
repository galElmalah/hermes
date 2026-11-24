import XCTest
@testable import CadenceKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Server resolution, launch state from the stored token, 401 vs transient failures, retry/backoff.
final class SessionAndReconnectTests: XCTestCase {

    // MARK: Server

    func testProductionServerFromInfoPlist() {
        XCTAssertEqual(ServerConfig.production(infoPlistValue: "https://hermes.example.workers.dev")?.absoluteString,
                       "https://hermes.example.workers.dev")
        // trailing slash / path dropped, host lower-cased
        XCTAssertEqual(ServerConfig.production(infoPlistValue: " https://Hermes.example.workers.dev/ ")?.absoluteString,
                       "https://hermes.example.workers.dev")
        XCTAssertNil(ServerConfig.production(infoPlistValue: nil))
        XCTAssertNil(ServerConfig.production(infoPlistValue: ""))
        XCTAssertNil(ServerConfig.production(infoPlistValue: "$(HERMES_SERVER_URL)"), "unexpanded build setting")
        XCTAssertNil(ServerConfig.production(infoPlistValue: "https:"), "xcconfig // comment truncation")
        XCTAssertNil(ServerConfig.production(infoPlistValue: "http://localhost:5173"), "production must be https")
    }

    func testDevelopmentOverrideWinsOnlyWhenValid() {
        let prod = "https://hermes.example.workers.dev"
        XCTAssertEqual(ServerConfig.resolve(infoPlistValue: prod, override: nil)?.absoluteString, prod)
        XCTAssertEqual(ServerConfig.resolve(infoPlistValue: prod, override: "  ")?.absoluteString, prod)
        XCTAssertEqual(ServerConfig.resolve(infoPlistValue: prod, override: "http://localhost:5181")?.absoluteString,
                       "http://localhost:5181")
        XCTAssertEqual(ServerConfig.resolve(infoPlistValue: prod, override: "localhost:5181")?.absoluteString,
                       "http://localhost:5181")
        // plain http to a public host is rejected → production
        XCTAssertEqual(ServerConfig.resolve(infoPlistValue: prod, override: "http://evil.example.com")?.absoluteString, prod)
        XCTAssertNil(ServerConfig.resolve(infoPlistValue: nil, override: nil))
    }

    func testSavedServerBeatsBuildDefault() {
        let saved = URL(string: "https://mine.example.workers.dev")!
        XCTAssertEqual(ServerConfig.resolve(infoPlistValue: "https://default.example.dev", override: nil, saved: saved), saved)
        XCTAssertEqual(ServerConfig.resolve(infoPlistValue: nil, override: nil, saved: saved), saved)
        XCTAssertEqual(ServerConfig.resolve(infoPlistValue: nil, override: "http://localhost:8787", saved: saved)?.absoluteString, "http://localhost:8787")
    }

    func testServerStoreSavesAndAdoptsTheTokenServer() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "ServerStoreTests-\(UUID().uuidString)"))
        let store = ServerStore(defaults: defaults)
        XCTAssertNil(store.saved)
        store.adoptIfMissing(from: .absent)
        XCTAssertNil(store.saved, "nothing to adopt without a token")

        let issuer = URL(string: "https://old.example.workers.dev")!
        store.adoptIfMissing(from: .found(DeviceCredentials(serverURL: issuer, token: "cad_x")))
        XCTAssertEqual(store.saved, issuer)

        let chosen = URL(string: "https://new.example.workers.dev")!
        store.save(chosen)
        store.adoptIfMissing(from: .found(DeviceCredentials(serverURL: issuer, token: "cad_x")))
        XCTAssertEqual(store.saved, chosen, "a saved server is never overwritten")

        defaults.set("not a url at all", forKey: ServerStore.key)
        XCTAssertNil(store.saved)
        store.clear()
        XCTAssertNil(defaults.string(forKey: ServerStore.key))
    }

    func testRestoreUsesFixedServerAndIgnoresStoredAddress() async throws {
        let fixed = URL(string: "https://hermes.example.workers.dev")!
        let store = InMemoryTokenStore(DeviceCredentials(serverURL: URL(string: "http://192.168.1.20:5240")!, token: "cad_old"))
        let t = MockTransport([try .fixture("snapshot")])
        let client = try XCTUnwrap(APIClient.restore(baseURL: fixed, tokenStore: store, transport: t))
        XCTAssertEqual(client.baseURL, fixed)
        _ = try await client.snapshot()
        XCTAssertEqual(t.lastRequest?.url?.host, "hermes.example.workers.dev")
        XCTAssertEqual(t.lastRequest?.value(forHTTPHeaderField: "Authorization"), "Bearer cad_old")
        XCTAssertNil(APIClient.restore(baseURL: fixed, tokenStore: InMemoryTokenStore(), transport: t))
    }

    // MARK: Launch state

    func testLaunchPhaseFromStoredToken() {
        let creds = DeviceCredentials(serverURL: URL(string: "https://x.example")!, token: "cad_x")
        XCTAssertEqual(LaunchPhase.initial(.found(creds)), .signedIn)
        XCTAssertEqual(LaunchPhase.initial(.absent), .signedOut)
        // keychain locked (before first unlock / prewarm): never show the passphrase screen for that
        XCTAssertEqual(LaunchPhase.initial(.unavailable), .signedIn)
        XCTAssertEqual(LaunchPhase.initial(InMemoryTokenStore(creds).lookup()), .signedIn)
        XCTAssertEqual(LaunchPhase.initial(InMemoryTokenStore().lookup()), .signedOut)
    }

    #if canImport(Security) && os(macOS)
    func testKeychainLookupDistinguishesAbsent() throws {
        let store = KeychainTokenStore(service: "app.hermes.tests.\(UUID().uuidString)", accessGroup: nil)
        defer { store.clear() }
        let first = store.lookup()
        if first == .unavailable { throw XCTSkip("keychain not usable in this test environment") }
        XCTAssertEqual(first, .absent)
        let creds = DeviceCredentials(serverURL: URL(string: "https://x.example")!, token: "cad_k")
        do { try store.save(creds) } catch { throw XCTSkip("keychain not writable here: \(error)") }
        XCTAssertEqual(store.lookup(), .found(creds))
        store.clear()
        XCTAssertEqual(store.lookup(), .absent)
    }
    #endif

    // MARK: 401 vs transient

    func testOnlyUnauthorizedSignsOut() {
        XCTAssertTrue(SessionPolicy.signsOut(.unauthorized))
        let transient: [APIError] = [
            .transport(message: "offline", offline: true),
            .transport(message: "tls", offline: false),
            .server(code: "internal", message: "x", status: 500),
            .server(code: "internal", message: "x", status: 503),
            .throttled(retryAfter: 5, code: "too_many_requests", message: ""),
            .decoding(detail: "x"),
            .notConnected,
            .server(code: "invalid_passphrase", message: "x", status: 401),
        ]
        for e in transient { XCTAssertFalse(SessionPolicy.signsOut(e), "\(e)") }
    }

    func testTransientFailuresKeepTheToken() async throws {
        let cases: [(MockTransport, APIError)] = [
            (MockTransport([.json(503, #"{"error":{"code":"internal","message":"down"}}"#)]),
             .server(code: "internal", message: "down", status: 503)),
            (MockTransport([.json(502, "<html>bad gateway</html>")]),
             .server(code: "internal", message: "Bad gateway", status: 502)),
        ]
        for (t, expected) in cases {
            let flag = Flag()
            let (client, store) = makeClient(t, onUnauthorized: { flag.set() })
            do { _ = try await client.snapshot(); XCTFail("expected an error") } catch let e as APIError {
                XCTAssertEqual(e.code, expected.code)
                XCTAssertTrue(RetryPolicy.isRetryable(e))
                XCTAssertFalse(SessionPolicy.signsOut(e))
            }
            XCTAssertEqual(store.token, "cad_test", "a 5xx must not sign out")
            XCTAssertFalse(flag.value)
        }

        for code in [URLError.Code.notConnectedToInternet, .timedOut, .cannotConnectToHost, .networkConnectionLost] {
            let t = MockTransport([])
            t.error = URLError(code)
            let flag = Flag()
            let (client, store) = makeClient(t, onUnauthorized: { flag.set() })
            do { _ = try await client.today(); XCTFail("expected an error") } catch let e as APIError {
                XCTAssertTrue(e.isOffline, "\(code)")
                XCTAssertTrue(RetryPolicy.isRetryable(e))
            }
            XCTAssertEqual(store.token, "cad_test", "offline must not sign out")
            XCTAssertFalse(flag.value)
        }
    }

    func testRevokedTokenSignsOut() async throws {
        let t = MockTransport([.json(401, #"{"error":{"code":"unauthorized","message":"Unauthorized"}}"#)])
        let flag = Flag()
        let outcomes = Outcomes()
        let base = URL(string: "https://hermes.example.com")!
        let store = InMemoryTokenStore(DeviceCredentials(serverURL: base, token: "cad_t"))
        let client = APIClient(baseURL: base, tokenStore: store, transport: t, onUnauthorized: { flag.set() },
                               onOutcome: { outcomes.append($0) })
        do { _ = try await client.snapshot(); XCTFail("expected an error") } catch let e as APIError {
            XCTAssertEqual(e, .unauthorized)
            XCTAssertTrue(SessionPolicy.signsOut(e))
            XCTAssertFalse(RetryPolicy.isRetryable(e))
        }
        XCTAssertNil(store.token)
        XCTAssertTrue(flag.value)
        XCTAssertEqual(outcomes.values, [.reached])
    }

    func testClientReportsOutcomes() async throws {
        let base = URL(string: "https://hermes.example.com")!
        let store = InMemoryTokenStore(DeviceCredentials(serverURL: base, token: "cad_t"))
        let outcomes = Outcomes()
        let t = MockTransport([.json(500, "{}"), try .fixture("snapshot"), .json(404, #"{"error":{"code":"not_found","message":"nope"}}"#)])
        let client = APIClient(baseURL: base, tokenStore: store, transport: t, onOutcome: { outcomes.append($0) })
        _ = try? await client.snapshot()
        _ = try await client.snapshot()
        _ = try? await client.workout(id: "wk_x")
        XCTAssertEqual(outcomes.values.count, 3)
        if case .transientFailure(let e) = outcomes.values[0] { XCTAssertEqual(e.code, "internal") } else { XCTFail() }
        XCTAssertEqual(Array(outcomes.values.dropFirst()), [.reached, .reached])

        let offline = MockTransport([])
        offline.error = URLError(.notConnectedToInternet)
        let outcomes2 = Outcomes()
        let c2 = APIClient(baseURL: base, tokenStore: store, transport: offline, onOutcome: { outcomes2.append($0) })
        _ = try? await c2.snapshot()
        XCTAssertEqual(outcomes2.values.count, 1)
        if case .transientFailure(let e) = outcomes2.values[0] { XCTAssertTrue(e.isOffline) } else { XCTFail() }

        // cancellation says nothing about the server
        let cancelled = MockTransport([])
        cancelled.error = URLError(.cancelled)
        let outcomes3 = Outcomes()
        let c3 = APIClient(baseURL: base, tokenStore: store, transport: cancelled, onOutcome: { outcomes3.append($0) })
        _ = try? await c3.snapshot()
        XCTAssertEqual(outcomes3.values, [])
    }

    // MARK: Retry / backoff

    func testRetryableClassification() {
        XCTAssertTrue(RetryPolicy.isRetryable(.transport(message: "x", offline: true)))
        XCTAssertTrue(RetryPolicy.isRetryable(.transport(message: "x", offline: false)))
        XCTAssertTrue(RetryPolicy.isRetryable(.server(code: "internal", message: "", status: 500)))
        XCTAssertTrue(RetryPolicy.isRetryable(.server(code: "x", message: "", status: 504)))
        XCTAssertTrue(RetryPolicy.isRetryable(.throttled(retryAfter: nil, code: "x", message: "")))
        XCTAssertFalse(RetryPolicy.isRetryable(.server(code: "not_found", message: "", status: 404)))
        XCTAssertFalse(RetryPolicy.isRetryable(.server(code: "validation", message: "", status: 400)))
        XCTAssertFalse(RetryPolicy.isRetryable(.unauthorized))
        XCTAssertFalse(RetryPolicy.isRetryable(.decoding(detail: "")))
        XCTAssertFalse(RetryPolicy.isRetryable(.notConnected))
        XCTAssertEqual(RequestOutcome(error: .unauthorized), .reached)
        XCTAssertEqual(RequestOutcome(error: .server(code: "not_found", message: "", status: 404)), .reached)
        XCTAssertNil(RequestOutcome(error: .decoding(detail: "")))
        XCTAssertNil(RequestOutcome(error: .notConnected))
    }

    func testBackoffDelays() {
        let p = RetryPolicy.standard
        let plain = (1...8).map { p.delay(forAttempt: $0, random: 0.5) }
        XCTAssertEqual(plain, [2, 4, 8, 16, 32, 60, 60, 60])
        // jitter stays within ±20 % and under the cap
        XCTAssertEqual(p.delay(forAttempt: 1, random: 0), 1.6, accuracy: 0.0001)
        XCTAssertEqual(p.delay(forAttempt: 1, random: 1), 2.4, accuracy: 0.0001)
        XCTAssertEqual(p.delay(forAttempt: 10, random: 1), 60)
        XCTAssertEqual(p.delay(forAttempt: 0, random: 0.5), 2, "attempt is clamped to 1")
        // Retry-After is a floor
        XCTAssertEqual(p.delay(forAttempt: 1, after: .throttled(retryAfter: 30, code: "x", message: ""), random: 0.5), 30)
        for _ in 0..<100 {
            let d = p.delay(forAttempt: Int.random(in: 1...20))
            XCTAssertTrue((0.5...60).contains(d))
        }
    }

    func testRecoveryStateMachine() {
        var s = RecoveryState()
        XCTAssertEqual(s.record(.reached), .none)
        XCTAssertEqual(s.connectivityMayHaveReturned(), .none, "nothing to recover")

        let offline = APIError.transport(message: "x", offline: true)
        XCTAssertEqual(s.record(.transientFailure(offline)), .startRetrying)
        XCTAssertTrue(s.isDegraded)
        // more failures while degraded do not start a second loop
        XCTAssertEqual(s.record(.transientFailure(offline)), .none)
        XCTAssertEqual(s.nextDelay(random: 0.5), 2)
        XCTAssertEqual(s.nextDelay(random: 0.5), 4)
        XCTAssertEqual(s.nextDelay(random: 0.5), 8)
        XCTAssertEqual(s.attempt, 3)

        // network path back → retry now with a fresh backoff
        XCTAssertEqual(s.connectivityMayHaveReturned(), .retryNow)
        XCTAssertEqual(s.attempt, 0)
        XCTAssertEqual(s.nextDelay(random: 0.5), 2)

        // the server answers → recovered once
        XCTAssertEqual(s.record(.reached), .recovered)
        XCTAssertFalse(s.isDegraded)
        XCTAssertEqual(s.record(.reached), .none)

        XCTAssertEqual(s.record(.transientFailure(.server(code: "internal", message: "", status: 502))), .startRetrying)
        s.reset()
        XCTAssertFalse(s.isDegraded)
        XCTAssertEqual(s.attempt, 0)
    }

    func testScreensReloadAfterLongBackground() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertFalse(RecoveryState.reloadsScreensOnActivation(backgroundedAt: nil, now: now), "first activation after launch")
        XCTAssertFalse(RecoveryState.reloadsScreensOnActivation(backgroundedAt: now.addingTimeInterval(-5), now: now))
        XCTAssertTrue(RecoveryState.reloadsScreensOnActivation(backgroundedAt: now.addingTimeInterval(-30), now: now))
        XCTAssertTrue(RecoveryState.reloadsScreensOnActivation(backgroundedAt: now.addingTimeInterval(-3600), now: now))
    }
}

final class Outcomes: @unchecked Sendable {
    private let lock = NSLock()
    private var _values: [RequestOutcome] = []
    var values: [RequestOutcome] { lock.lock(); defer { lock.unlock() }; return _values }
    func append(_ o: RequestOutcome) { lock.lock(); _values.append(o); lock.unlock() }
}
