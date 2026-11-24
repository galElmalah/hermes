import Foundation
import SwiftUI
import UIKit
import WidgetKit
import CadenceKit

/// The app's tabs: Today · Calendar · Trends · Activities · More (Journal, Settings, devices, Garmin).
enum AppTab: String, Hashable, CaseIterable {
    case today, calendar, trends, activities, more
}

/// A short message at the bottom of the screen, optionally with Undo (no confirm dialogs anywhere).
struct ToastItem: Identifiable {
    let id = UUID()
    let message: String
    var undoTitle: String = "Undo"
    /// runs on the main actor; the toast closes first
    var undo: (@MainActor () async -> Void)?
}

/// App-wide state: connection, the API client, the latest snapshot and settings, navigation per tab,
/// and the toast. Injected with `.environment(appModel)`, read with `@Environment(AppModel.self)`.
///
/// Session: the server is fixed (`HermesServer`). The device token stays in the shared keychain until
/// the server answers 401 (revoked) or the user signs out — nothing else signs out. Transient failures
/// (offline, timeouts, 5xx) keep the cached data on screen and are retried with backoff, when the
/// network path comes back and when the app returns to the foreground (`RecoveryState`).
@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable {
        /// no stored device token → passphrase screen
        case signedOut
        case signedIn
    }

    // MARK: Connection & data

    private(set) var phase: Phase
    /// nil = not connected
    private(set) var client: APIClient? = nil
    private(set) var snapshot: MobileSnapshot? = nil
    private(set) var snapshotFetchedAt: Date? = nil
    /// Settable so Settings can apply a patched value at once; prefer `apply(_:)`, which also updates
    /// the widgets' shared preferences.
    var settings: AthleteSettings? = nil
    private(set) var isRefreshing = false
    /// last refresh error (nil after a successful refresh)
    var lastError: APIError? = nil
    /// Bumped after every write (`didWrite`): screens reload with `.task(id: model.dataVersion)`.
    private(set) var dataVersion = 0

    // MARK: Navigation

    var selectedTab: AppTab = .today
    var todayPath: [Route] = []
    var calendarPath: [Route] = []
    var trendsPath: [Route] = []
    var activitiesPath: [Route] = []
    var morePath: [Route] = []
    /// A date the calendar should show (set by deep links; the calendar clears it).
    var calendarFocus: LocalDate? = nil
    /// Set when a deep link asks for the morning check-in; the Today screen scrolls to it and clears it.
    var focusCheckIn = false
    var toast: ToastItem? = nil

    // MARK: Storage

    @ObservationIgnored let config: AppGroupConfig
    @ObservationIgnored let tokenStore: TokenStore
    @ObservationIgnored let snapshotCache: SnapshotCache
    @ObservationIgnored let responseCache: ResponseCache
    @ObservationIgnored let preferences: SharedPreferences
    /// Remembered open/closed state of collapsible sections (App Group defaults; kept on sign-out).
    @ObservationIgnored let sections: SectionStateStore
    /// The current server (saved at sign-in; see `HermesServer`). Changes when signing in elsewhere.
    @ObservationIgnored private(set) var serverURL: URL?

    // MARK: Reconnecting

    @ObservationIgnored private var recovery = RecoveryState()
    @ObservationIgnored private var recoveryTask: Task<Void, Never>? = nil
    @ObservationIgnored private let connectivity = Connectivity()
    @ObservationIgnored private var isActive = false
    @ObservationIgnored private var backgroundedAt: Date? = nil
    /// The keychain could not be read at launch (locked): stay on the signed-in UI and look again
    /// when the app becomes active.
    @ObservationIgnored private var credentialsPending = false

    init() {
        #if DEBUG
        HermesServer.DebugOverride.publishForExtensions()
        #endif
        let config = AppGroupConfig.fromInfoPlist()
        let tokenStore = KeychainTokenStore(accessGroup: config.keychainGroup)
        let snapshotCache = SnapshotCache(directory: config.containerURL)
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        let cached = snapshotCache.load()
        self.config = config
        self.tokenStore = tokenStore
        self.snapshotCache = snapshotCache
        self.responseCache = ResponseCache(directory: caches.appendingPathComponent("HermesResponses"))
        self.preferences = SharedPreferences(defaults: config.defaults)
        self.sections = SectionStateStore(defaults: config.defaults)
        self.snapshot = cached?.snapshot
        self.snapshotFetchedAt = cached?.fetchedAt
        // Decided synchronously from the keychain: a stored token opens straight into the tabs.
        let lookup = tokenStore.lookup()
        HermesServer.store.adoptIfMissing(from: lookup)
        self.serverURL = HermesServer.baseURL
        self.phase = LaunchPhase.initial(lookup) == .signedIn ? .signedIn : .signedOut
        self.credentialsPending = lookup == .unavailable
        self.client = makeClient(restoring: true)
        if let client, let s = client.cached(Endpoints.settings()) { settings = s.value }
        connectivity.onAvailable = { [weak self] in self?.networkBecameAvailable() }
        connectivity.start()
    }

    // MARK: Derived appearance

    var units: UnitSystem {
        if let u = settings?.units, u != .unknown { return u }
        if let u = snapshot?.units, u != .unknown { return u }
        let p = preferences.units
        return p == .unknown ? .metric : p
    }

    var accent: Accent {
        if let a = settings?.accent, a != .unknown { return a }
        let p = preferences.accent
        return p == .unknown ? .blue : p
    }

    var themePreference: ThemePreference {
        if let t = settings?.theme, t != .unknown { return t }
        return preferences.theme
    }

    var reduceMotionSetting: Bool { settings?.reducedMotion ?? false }

    /// The athlete's "today" (snapshot's, else the device's).
    var today: LocalDate {
        let local = Day(Date()).string
        guard let s = snapshot?.today else { return local }
        return max(s, local)
    }

    /// Tomorrow's sessions when the snapshot describes `date` as today.
    func tomorrowSessions(after date: LocalDate) -> [SnapshotSession]? {
        guard let s = snapshot, s.today == date else { return nil }
        return s.tomorrowSessions
    }

    var appVersion: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? CadenceKitInfo.version
    }

    // MARK: Client

    /// A client for `server` (default: the current server). `restoring`: only when a device token is stored.
    private func makeClient(restoring: Bool, server: URL? = nil) -> APIClient? {
        guard let serverURL = server ?? serverURL else { return nil }
        let onUnauthorized: @Sendable () -> Void = { [weak self] in
            Task { @MainActor in self?.didLoseAuthorization() }
        }
        let onOutcome: @Sendable (RequestOutcome) -> Void = { [weak self] outcome in
            Task { @MainActor in self?.handle(outcome) }
        }
        if restoring {
            return APIClient.restore(baseURL: serverURL, tokenStore: tokenStore, responseCache: responseCache,
                                     appVersion: appVersion, onUnauthorized: onUnauthorized, onOutcome: onOutcome)
        }
        return APIClient(baseURL: serverURL, tokenStore: tokenStore, responseCache: responseCache,
                         appVersion: appVersion, onUnauthorized: onUnauthorized, onOutcome: onOutcome)
    }

    // MARK: Connect / sign out

    /// Exchanges the passphrase for a device token with the server at `address` (the client stores
    /// it in the shared keychain), remembers the server for the app and its extensions, then loads
    /// the snapshot and settings. Throws `APIError`.
    func connect(address: String, passphrase: String, deviceName: String) async throws {
        let server = try ServerAddress.normalize(address)
        guard let fresh = makeClient(restoring: false, server: server) else { throw ServerConfig.missingError }
        try await fresh.connect(passphrase: passphrase, deviceName: ConnectForm.deviceName(deviceName))
        HermesServer.store.save(server)
        serverURL = server
        client = fresh
        credentialsPending = false
        recovery.reset()
        lastError = nil
        withAnimation(Theme.Motion.smooth) { phase = .signedIn }
        await refresh()
    }

    func signOut() async {
        await client?.signOut()
        didLoseAuthorization()
    }

    /// Signed out (by the user, or the token was revoked: 401). Drops everything this phone keeps
    /// about the account — token, snapshot (App Group), cached responses (app + widget), the widget's
    /// check-in record — then reloads the widgets so they show "Connect in the app".
    private func didLoseAuthorization() {
        stopRecovery()
        recovery.reset()
        credentialsPending = false
        lastError = nil
        client = nil
        snapshot = nil
        snapshotFetchedAt = nil
        settings = nil
        tokenStore.clear()
        snapshotCache.clear()
        responseCache.removeAll()
        ResponseCache(directory: config.containerURL.appendingPathComponent("WidgetResponses", isDirectory: true)).removeAll()
        CheckInStore(defaults: config.defaults).clear()
        todayPath = []; calendarPath = []; trendsPath = []; activitiesPath = []; morePath = []
        selectedTab = .today
        toast = nil
        withAnimation(Theme.Motion.smooth) { phase = .signedOut }
        WidgetCenter.shared.reloadAllTimelines()
    }

    // MARK: Data

    /// Snapshot only (also feeds the widgets); reloads widget timelines.
    func refreshSnapshot() async {
        guard let client else { return }
        do {
            let now = Date()
            let s = try await client.refreshSnapshot(into: snapshotCache, now: now)
            snapshot = s
            snapshotFetchedAt = now
            lastError = nil
            WidgetCenter.shared.reloadAllTimelines()
        } catch let e as APIError {
            if e != .unauthorized { lastError = e }
        } catch {
            // cancelled (pull-to-refresh released early)
        }
    }

    /// Snapshot + settings (foreground, pull to refresh, after connecting).
    func refresh() async {
        guard client != nil, !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        await refreshSnapshot()
        if let s = try? await client?.settings() { apply(s) }
    }

    /// Call after any mutation: refreshes the snapshot, reloads widgets and tells visible screens to reload.
    func didWrite() async {
        dataVersion &+= 1
        await refreshSnapshot()
    }

    /// After a small write the current screen already shows (autosaved notes, quick log): refresh the
    /// snapshot and the widgets without making visible screens reload under the user's fingers.
    func didWriteQuietly() async {
        await refreshSnapshot()
    }

    /// Applies settings fetched or patched elsewhere (appearance + the widgets' shared preferences).
    func apply(_ s: AthleteSettings) {
        settings = s
        preferences.apply(s)
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Background app refresh: a quiet snapshot update for the widgets.
    func backgroundRefresh() async {
        if client == nil { reloadCredentialsIfPending() }
        guard client != nil else { return }
        await refreshSnapshot()
    }

    // MARK: Foreground, background, reconnecting

    /// The scene became active (launch or back from the background): refresh the snapshot and
    /// settings; after a longer absence or while degraded also reload what the screens show.
    func sceneBecameActive() {
        isActive = true
        reloadCredentialsIfPending()
        guard phase == .signedIn, client != nil else { return }
        if RecoveryState.reloadsScreensOnActivation(backgroundedAt: backgroundedAt, now: Date()) || recovery.isDegraded {
            dataVersion &+= 1
        }
        backgroundedAt = nil
        if recovery.connectivityMayHaveReturned() == .retryNow { stopRecovery() }
        Task { await refresh() }
    }

    func sceneEnteredBackground() {
        isActive = false
        backgroundedAt = Date()
        // no retry loop in the background (background app refresh and widgets take over)
        stopRecovery()
    }

    /// NWPathMonitor: a usable network path appeared.
    private func networkBecameAvailable() {
        guard recovery.connectivityMayHaveReturned() == .retryNow, isActive else { return }
        stopRecovery()
        startRecovery(immediately: true)
    }

    /// Every request's result, reported by the client.
    private func handle(_ outcome: RequestOutcome) {
        guard phase == .signedIn else { return }
        switch recovery.record(outcome) {
        case .startRetrying:
            // visible screens reload once: each keeps its saved data and shows the quiet offline line
            dataVersion &+= 1
            startRecovery(immediately: false)
        case .recovered:
            stopRecovery()
            lastError = nil
            // screens showing saved data reload; the snapshot (widgets) and settings follow
            dataVersion &+= 1
            Task { await refresh() }
        case .none, .retryNow:
            if case .transientFailure = outcome, recovery.isDegraded, recoveryTask == nil { startRecovery(immediately: false) }
        }
    }

    /// Retries the snapshot with backoff until the server answers (then `handle(.reached)` stops it)
    /// or the app leaves the foreground.
    private func startRecovery(immediately: Bool) {
        guard recoveryTask == nil, isActive, client != nil else { return }
        recoveryTask = Task { [weak self] in
            var first = immediately
            while !Task.isCancelled {
                guard let self else { return }
                if !first {
                    let delay = self.recovery.nextDelay(after: self.lastError)
                    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                    if Task.isCancelled { return }
                }
                first = false
                guard self.recovery.isDegraded, self.client != nil else { break }
                await self.refreshSnapshot()
                if !self.recovery.isDegraded { break }
            }
            // a cancelled loop was already replaced (or stopped) by stopRecovery()
            if !Task.isCancelled { self?.recoveryTask = nil }
        }
    }

    private func stopRecovery() {
        recoveryTask?.cancel()
        recoveryTask = nil
    }

    /// The keychain was locked at launch: read it again (signed in if a token is there now; the
    /// passphrase screen only when the keychain says definitely nothing is stored).
    private func reloadCredentialsIfPending() {
        guard credentialsPending else { return }
        switch tokenStore.lookup() {
        case .found:
            credentialsPending = false
            client = makeClient(restoring: true)
            if let client, settings == nil, let s = client.cached(Endpoints.settings()) { settings = s.value }
        case .absent:
            credentialsPending = false
            didLoseAuthorization()
        case .unavailable:
            break
        }
    }

    // MARK: Navigation

    /// The selected tab's navigation path.
    var path: [Route] {
        get { routes(for: selectedTab) }
        set { setRoutes(newValue, for: selectedTab) }
    }

    func routes(for tab: AppTab) -> [Route] {
        switch tab {
        case .today: return todayPath
        case .calendar: return calendarPath
        case .trends: return trendsPath
        case .activities: return activitiesPath
        case .more: return morePath
        }
    }

    func setRoutes(_ routes: [Route], for tab: AppTab) {
        switch tab {
        case .today: todayPath = routes
        case .calendar: calendarPath = routes
        case .trends: trendsPath = routes
        case .activities: activitiesPath = routes
        case .more: morePath = routes
        }
    }

    /// Pushes a route on the selected tab.
    func push(_ route: Route) { path.append(route) }

    /// Pops the top screen of the selected tab.
    func pop() { if !path.isEmpty { path.removeLast() } }

    /// Compatibility with the lead's / intents' convention (`model.pendingLink = link`): assigning opens it.
    var pendingLink: DeepLink? {
        get { nil }
        set { if let newValue { open(newValue) } }
    }

    func open(_ url: URL) {
        if let link = DeepLink(url: url) { open(link) }
    }

    /// Selects the right tab and pushes the route for a deep link (widgets, search, notifications).
    func open(_ link: DeepLink) {
        guard phase == .signedIn else { return }
        switch link {
        case .today:
            show(.today, [])
        case .checkIn:
            show(.today, [])
            focusCheckIn = true
        case .calendar(let date):
            calendarFocus = date ?? today
            show(.calendar, date.map { [.day($0)] } ?? [])
        case .month(let month):
            calendarFocus = MonthID(month).map { $0.firstDay.string }
            show(.calendar, [])
        case .week(let w):
            show(.calendar, [.week(w)])
        case .workout(let id):
            show(selectedTab == .more ? .today : selectedTab, [.workout(id: id)], keepStack: true)
        case .activity(let id):
            show(.activities, [.activity(id: id)])
        case .event(let id):
            show(.calendar, [.event(id: id)])
        case .newWorkout(let date):
            show(.calendar, [.newWorkout(date: date ?? today)])
        case .template:
            // workout templates (library) have no screen in the app yet
            show(.calendar, [])
            showToast("Workout templates open in the web app for now.")
        case .trends:
            show(.trends, [])
        }
    }

    private func show(_ tab: AppTab, _ routes: [Route], keepStack: Bool = false) {
        selectedTab = tab
        if keepStack {
            setRoutes(self.routes(for: tab) + routes, for: tab)
        } else {
            setRoutes(routes, for: tab)
        }
    }

    // MARK: Toast

    func showToast(_ message: String, undo: (@MainActor () async -> Void)? = nil) {
        withAnimation(Theme.Motion.snappy) { toast = ToastItem(message: message, undo: undo) }
    }

    /// Shows an error from a failed write (offline gets the quiet wording).
    func showError(_ error: Error, doing action: String) {
        let message: String
        if let e = error as? APIError {
            if e == .unauthorized { return }
            message = e.isOffline ? "You\u{2019}re offline \u{2014} couldn\u{2019}t \(action)." : "Couldn\u{2019}t \(action): \(e.message)"
        } else if error is CancellationError {
            return
        } else {
            message = "Couldn\u{2019}t \(action)."
        }
        showToast(message)
    }
}
