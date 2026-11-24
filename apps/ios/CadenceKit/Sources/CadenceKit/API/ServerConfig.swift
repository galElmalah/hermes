import Foundation

/// Which Hermes server the app talks to. Hermes is self-hosted, so each person enters the address of
/// their own deployment on the connect screen; it is remembered in the App Group (`ServerStore`) so
/// the widgets and App Intents follow it.
///
/// A build may also carry a default address — Info.plist key `HermesServerURL`, filled by
/// project.yml from `HERMES_SERVER_URL` (Config/Hermes.xcconfig or Config/Local.xcconfig). It only
/// pre-fills the connect screen until an address has been saved. Public builds leave it empty.
///
/// Debug builds of the app may pass an override (a local dev server); that lookup lives in the app
/// targets under `#if DEBUG` (Shared/HermesServer.swift), so Release binaries cannot reach it.
/// CadenceKit only validates whatever string it is given.
public enum ServerConfig {
    /// Info.plist key holding the production origin.
    public static let infoPlistKey = "HermesServerURL"

    /// The production origin from an Info.plist value. Must spell out `https://`; nil when missing,
    /// unexpanded (`$(HERMES_SERVER_URL)`), cut at `//` by the xcconfig parser, or not https.
    public static func production(infoPlistValue: String?) -> URL? {
        guard let raw = infoPlistValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              raw.lowercased().hasPrefix("https://"), !raw.contains("$("),
              let url = try? ServerAddress.normalize(raw), url.scheme == "https" else { return nil }
        return url
    }

    /// The production origin of a bundle (the app's or the widget extension's own Info.plist).
    public static func production(bundle: Bundle = .main) -> URL? {
        production(infoPlistValue: bundle.object(forInfoDictionaryKey: infoPlistKey) as? String)
    }

    /// A development override (debug builds only). Plain HTTP is accepted for local hosts only
    /// (`ServerAddress.normalize` rules); nil when empty or invalid.
    public static func developmentOverride(_ value: String?) -> URL? {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        return try? ServerAddress.normalize(raw)
    }

    /// The origin to use: a valid debug override wins, then the address saved at sign-in, then the
    /// build's default. Release callers pass `override: nil`.
    public static func resolve(infoPlistValue: String?, override: String?, saved: URL? = nil) -> URL? {
        developmentOverride(override) ?? saved ?? production(infoPlistValue: infoPlistValue)
    }

    /// The error the connect screen shows when no server address is known yet.
    public static let missingError = APIError.invalidBaseURL(reason: "Enter your Hermes server address.")
}

/// The server address chosen on the connect screen, shared through the App Group defaults so the
/// widget extension and App Intents use the same server as the app.
public struct ServerStore: @unchecked Sendable { // UserDefaults is thread-safe
    public static let key = "hermes.serverURL"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults) { self.defaults = defaults }

    /// The saved origin (nil when none, or when the stored value no longer validates).
    public var saved: URL? {
        guard let raw = defaults.string(forKey: Self.key) else { return nil }
        return try? ServerAddress.normalize(raw)
    }

    public func save(_ url: URL) { defaults.set(url.absoluteString, forKey: Self.key) }
    public func clear() { defaults.removeObject(forKey: Self.key) }

    /// Builds before the server became a choice kept it only in Info.plist. When a token is stored
    /// but no server is saved, adopt the server that issued the token, so an update never strands a
    /// signed-in phone. No-op otherwise.
    public func adoptIfMissing(from lookup: CredentialLookup) {
        guard saved == nil, case .found(let credentials) = lookup,
              let url = try? ServerAddress.normalize(credentials.serverURL.absoluteString) else { return }
        save(url)
    }
}
