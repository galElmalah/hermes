import Foundation

// Staying signed in and reconnecting on their own (the app's AppModel drives these; all decisions
// live here so they are unit-tested):
//  - only an explicit 401 from the server signs the device out (`SessionPolicy`);
//  - offline, timeouts, 5xx and throttling are transient: keep the token and the cached data,
//    retry with exponential backoff (`RetryPolicy`) and when the network path comes back
//    (`RecoveryState`).

/// What one request said about the server's reachability (reported by `APIClient` via `onOutcome`).
public enum RequestOutcome: Equatable, Sendable {
    /// The server answered with something other than a 5xx (2xx, 4xx, 401 …).
    case reached
    /// No answer, or a 5xx/429: worth retrying later.
    case transientFailure(APIError)

    /// nil for errors that say nothing about reachability (cancellation, decoding, not connected).
    public init?(error: APIError) {
        if RetryPolicy.isRetryable(error) { self = .transientFailure(error); return }
        switch error {
        case .unauthorized, .server: self = .reached
        default: return nil
        }
    }
}

/// When a failure signs the device out.
public enum SessionPolicy {
    /// Only an explicit 401 (unknown or revoked device token) ends the session. Offline, timeouts,
    /// 5xx, throttling, decoding errors and a temporarily unreadable keychain never do.
    public static func signsOut(_ error: APIError) -> Bool { error == .unauthorized }
}

/// Exponential backoff for transient failures.
public struct RetryPolicy: Equatable, Sendable {
    /// delay before the first retry (seconds)
    public var initialDelay: TimeInterval
    public var multiplier: Double
    /// cap (seconds); retries continue at this pace while the app is in the foreground
    public var maxDelay: TimeInterval
    /// ± fraction of random spread (0.2 = ±20 %)
    public var jitter: Double

    public init(initialDelay: TimeInterval = 2, multiplier: Double = 2, maxDelay: TimeInterval = 60, jitter: Double = 0.2) {
        self.initialDelay = initialDelay; self.multiplier = multiplier; self.maxDelay = maxDelay; self.jitter = jitter
    }

    public static let standard = RetryPolicy()

    /// Transport failures (offline, DNS, refused, timeouts, TLS), 5xx and 429.
    public static func isRetryable(_ error: APIError) -> Bool {
        switch error {
        case .transport: return true
        case .throttled: return true
        case .server(_, _, let status): return status >= 500 || status == 408
        case .unauthorized, .decoding, .invalidBaseURL, .notConnected: return false
        }
    }

    /// Delay before retry number `attempt` (1-based): 2, 4, 8, 16, 32, 60, 60 … seconds (± jitter).
    /// `random` in 0…1 (0.5 = no jitter); a throttled error's Retry-After is honoured as a minimum.
    public func delay(forAttempt attempt: Int, after error: APIError? = nil, random: Double = Double.random(in: 0...1)) -> TimeInterval {
        let n = max(1, attempt)
        let base = min(maxDelay, initialDelay * pow(multiplier, Double(n - 1)))
        let spread = 1 + jitter * (min(1, max(0, random)) * 2 - 1)
        var d = min(maxDelay, base * spread)
        if case .throttled(let retryAfter?, _, _)? = error { d = max(d, retryAfter) }
        return max(0.5, d)
    }
}

/// The app's "degraded until the server answers again" state.
public struct RecoveryState: Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        case none
        /// start the backoff loop (nothing is scheduled yet)
        case startRetrying
        /// the server answered again after failures: reload what the screens show
        case recovered
        /// retry at once (network path came back / app in the foreground) and restart the backoff
        case retryNow
    }

    public private(set) var isDegraded = false
    /// retries made in the current degraded period
    public private(set) var attempt = 0
    public var policy: RetryPolicy

    public init(policy: RetryPolicy = .standard) { self.policy = policy }

    public mutating func record(_ outcome: RequestOutcome) -> Action {
        switch outcome {
        case .reached:
            guard isDegraded else { return .none }
            isDegraded = false
            attempt = 0
            return .recovered
        case .transientFailure:
            guard !isDegraded else { return .none }
            isDegraded = true
            attempt = 0
            return .startRetrying
        }
    }

    /// The delay before the next retry (advances the attempt counter).
    public mutating func nextDelay(after error: APIError? = nil, random: Double = Double.random(in: 0...1)) -> TimeInterval {
        attempt += 1
        return policy.delay(forAttempt: attempt, after: error, random: random)
    }

    /// NWPathMonitor reported a usable path, or the scene became active.
    public mutating func connectivityMayHaveReturned() -> Action {
        guard isDegraded else { return .none }
        attempt = 0
        return .retryNow
    }

    /// Signed out: forget everything.
    public mutating func reset() {
        isDegraded = false
        attempt = 0
    }

    /// Whether screens should reload when the app comes back to the foreground (they keep showing
    /// what they have meanwhile). Not on the first activation after launch (screens load anyway).
    public static func reloadsScreensOnActivation(backgroundedAt: Date?, now: Date, minimumAway: TimeInterval = 30) -> Bool {
        guard let backgroundedAt else { return false }
        return now.timeIntervalSince(backgroundedAt) >= minimumAway
    }
}

/// What the stored credentials say at launch.
public enum CredentialLookup: Equatable, Sendable {
    case found(DeviceCredentials)
    /// definitely nothing stored (never connected, signed out, revoked)
    case absent
    /// the keychain could not be read right now (device locked before first unlock, prewarm):
    /// not a sign-out — look again when the app becomes active
    case unavailable
}

/// The first screen at launch, decided synchronously so there is no flash of the passphrase screen.
public enum LaunchPhase: Equatable, Sendable {
    case signedIn
    case signedOut

    public static func initial(_ lookup: CredentialLookup) -> LaunchPhase {
        switch lookup {
        case .found, .unavailable: return .signedIn
        case .absent: return .signedOut
        }
    }
}
