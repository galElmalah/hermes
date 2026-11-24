import Foundation

/// Identifiers shared by the app and the widget extension. Values come from Info.plist keys that
/// project.yml fills from Config/Hermes.xcconfig, so the owner edits one file:
///   HermesAppGroup       → $(HERMES_APP_GROUP)                          e.g. group.com.example.hermes
///   HermesKeychainGroup  → $(AppIdentifierPrefix)$(HERMES_KEYCHAIN_GROUP) e.g. ABCDE12345.com.example.hermes.shared
public struct AppGroupConfig: Hashable, Sendable {
    public var appGroup: String
    public var keychainGroup: String?

    public init(appGroup: String, keychainGroup: String?) {
        self.appGroup = appGroup
        self.keychainGroup = keychainGroup
    }

    /// Reads both keys from a bundle's Info.plist (the app's or the widget extension's own).
    public static func fromInfoPlist(_ bundle: Bundle = .main) -> AppGroupConfig {
        let group = bundle.object(forInfoDictionaryKey: "HermesAppGroup") as? String
        let keychain = bundle.object(forInfoDictionaryKey: "HermesKeychainGroup") as? String
        return AppGroupConfig(
            appGroup: (group?.isEmpty == false) ? group! : "group.app.hermes",
            keychainGroup: (keychain?.isEmpty == false && keychain?.contains("$(") == false) ? keychain : nil
        )
    }

    /// The App Group container, or a fallback in Application Support when the entitlement is missing
    /// (simulator without signing). On non-Apple platforms: the temporary directory.
    public var containerURL: URL {
        #if canImport(Darwin)
        if let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) {
            return url
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return support ?? FileManager.default.temporaryDirectory
        #else
        return FileManager.default.temporaryDirectory.appendingPathComponent(appGroup)
        #endif
    }

    /// UserDefaults shared with the widget extension (accent, units, last refresh).
    public var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }
}

/// Small preferences both targets read: the accent and units from `AthleteSettings`, so widgets match the
/// app without a network call. The app writes them after every settings fetch/patch.
public struct SharedPreferences: @unchecked Sendable {
    public let defaults: UserDefaults

    public init(defaults: UserDefaults) { self.defaults = defaults }

    public var accent: Accent {
        get { Accent(rawValue: defaults.string(forKey: "hermes.accent") ?? "") ?? .blue }
        nonmutating set { defaults.set(newValue.rawValue, forKey: "hermes.accent") }
    }

    public var units: UnitSystem {
        get { UnitSystem(rawValue: defaults.string(forKey: "hermes.units") ?? "") ?? .metric }
        nonmutating set { defaults.set(newValue.rawValue, forKey: "hermes.units") }
    }

    public var theme: ThemePreference {
        get { ThemePreference(rawValue: defaults.string(forKey: "hermes.theme") ?? "") ?? .system }
        nonmutating set { defaults.set(newValue.rawValue, forKey: "hermes.theme") }
    }

    public func apply(_ settings: AthleteSettings) {
        if settings.accent != .unknown { accent = settings.accent }
        if settings.units != .unknown { units = settings.units }
        if settings.theme != .unknown { theme = settings.theme }
    }
}
