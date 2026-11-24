import Foundation
import CadenceKit

/// The server the app, the widgets and the App Intents talk to: the address saved when the person
/// signed in (App Group, `ServerStore`), else the build's optional default from Info.plist
/// `HermesServerURL` (`HERMES_SERVER_URL` in the xcconfig), else none — the connect screen asks.
///
/// Debug builds only (compiled out of Release): a development override, so tests and the simulator
/// can use a local server —
///   launch argument  `-HermesDebugServerURL http://localhost:5173`
///   or environment   `HERMES_DEBUG_SERVER_URL=http://localhost:5173`
/// The app copies the override into the App Group defaults at launch (and removes it when launched
/// without one) so the widget extension and App Intents follow the same server.
enum HermesServer {
    /// nil until a server has been chosen (and the build has no default).
    static var baseURL: URL? {
        #if DEBUG
        if let url = DebugOverride.current { return url }
        #endif
        return store.saved ?? ServerConfig.production(bundle: .main)
    }

    /// Remembers the server after a successful sign-in (shared with the extensions).
    static var store: ServerStore { ServerStore(defaults: AppGroupConfig.fromInfoPlist().defaults) }

    #if DEBUG
    enum DebugOverride {
        static let argument = "-HermesDebugServerURL"
        static let environment = "HERMES_DEBUG_SERVER_URL"
        private static let defaultsKey = "hermes.debugServerURL"

        /// The override from this process's launch (the app) or from the App Group (widgets, intents).
        static var current: URL? {
            if let fromLaunch = launchValue { return ServerConfig.developmentOverride(fromLaunch) }
            return ServerConfig.developmentOverride(AppGroupConfig.fromInfoPlist().defaults.string(forKey: defaultsKey))
        }

        /// The app calls this at launch: share (or forget) the override for the extensions.
        static func publishForExtensions() {
            let defaults = AppGroupConfig.fromInfoPlist().defaults
            if let value = launchValue, ServerConfig.developmentOverride(value) != nil {
                defaults.set(value, forKey: defaultsKey)
            } else {
                defaults.removeObject(forKey: defaultsKey)
            }
        }

        private static var launchValue: String? {
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: argument), i + 1 < args.count { return args[i + 1] }
            let env = ProcessInfo.processInfo.environment[environment]
            return (env?.isEmpty == false) ? env : nil
        }
    }
    #endif
}
