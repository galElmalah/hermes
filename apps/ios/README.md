# Hermes for iOS

Native iPhone app and widgets for Hermes. It talks to the same Cloudflare Worker as the web app,
authenticated with a revocable **device token** (docs/MOBILE_API.md). iOS 17+, SwiftUI, WidgetKit,
no third-party dependencies.

```
apps/ios/
  project.yml            XcodeGen spec (app "Hermes" + widget extension "HermesWidgets")
  Config/Hermes.xcconfig  team, bundle id, App Group, keychain group (generic defaults)
  Config/Local.xcconfig   your overrides of the above (gitignored; create it)
  CadenceKit/            Swift package: models, API client, storage, formatting, view-models, tests
  App/                   app target: Today, Calendar, Trends, Activities, More (Journal, Settings, Garmin, devices)
  Widgets/               widget extension: Today, Week, Form, Next race, Check-in, Add-workout control (iOS 18)
  Shared/                compiled into both targets: Theme, data colours, components, charts, App Intents
  scripts/               linux-test.sh, typecheck-stubs.sh (+ stubs/), fixture capture/check, contract smoke, assets
  ENGINEERING.md         API surface and conventions (start here when changing code)
```

## Open and run on a Mac — first build, in order

The SwiftUI code has **never been compiled by Xcode** (it was written and checked on Linux, see
"Verified vs unverified" below). Expect the first build to surface a handful of SDK-level errors;
the list under "Known risks" says where to look first.

1. **Xcode 16 or newer** (Swift 6 compiler, iOS 18 SDK; deployment target stays iOS 17.0). Xcode 15
   should also work — every iOS 18 API sits behind `#if compiler(>=6.0)` — but it is not the tested path
   and its App Intents metadata extractor is older. Then `brew install xcodegen`.
2. Create `Config/Local.xcconfig` (gitignored; `Config/Hermes.xcconfig` includes it last) with your
   `HERMES_TEAM_ID` (Xcode → Settings → Accounts), `HERMES_BUNDLE_ID`, `HERMES_APP_GROUP` (must start
   with `group.`) and `HERMES_KEYCHAIN_GROUP`. Both targets read them. Optionally `HERMES_SERVER_URL`
   to pre-fill the connect screen in a build that is only for you (leave it empty for TestFlight).
3. `cd apps/ios && xcodegen && open Hermes.xcodeproj` (re-run `xcodegen` after pulling changes to
   `project.yml` or adding files; Info.plists and entitlements are generated, see `.gitignore`).
4. **Signing & Capabilities**, both targets (`Hermes`, `HermesWidgets`): the team comes from the
   xcconfig, signing is automatic. Check that each lists *App Groups* (`$(HERMES_APP_GROUP)`) and
   *Keychain Sharing* (`$(HERMES_KEYCHAIN_GROUP)`); with a paid team Xcode registers both ids. Without a
   team the app may still run in the simulator (the keychain then falls back to the app's own group and
   the App Group container to Application Support), but the widget cannot read the token and shows
   "Connect in the app". If Xcode refuses to build without a team, set one — that is a signing issue,
   not a code issue.
5. Build the **Hermes** scheme for an iPhone simulator (⌘B). Fix compile errors, if any, starting with
   the files under "Known risks". Then Run, connect (below), and walk through `Widgets/README.md`'s
   device checklist. To debug widgets, run the **HermesWidgets** scheme (Xcode asks for the host app).
6. Widgets: long-press the Home Screen → ＋ → Hermes. Controls (iOS 18): Control Center → ＋.

### Known risks for the first Xcode build (most likely first)

The Linux type-check (below) proves the code is consistent with the SDK declarations in
`scripts/stubs/`, which were written from Apple's iOS 17/18 signatures by hand. Where those stubs could
differ from the real SDK, or where Xcode checks things a compiler on Linux cannot:

1. **Swift Charts axes and selection** — `Shared/Charts/ChartAxes.swift` (`AxisMarks(values:) { AxisValueLabel { … } }`
   with `value.as(Double.self)` inside a `@ViewBuilder`), `App/Features/Trends/TrendsSections.swift`
   (`chartXSelection(value:)` bound to a `String?` on a categorical axis, `chartForegroundStyleScale(domain:range:)`,
   `.annotation(position:alignment:spacing:)` on `RuleMark`), `Shared/Charts/TrackChart.swift`.
2. **MapKit** — `App/Features/Activities/ActivityMap.swift`: `Map(position:interactionModes:) { … }` with
   `if let` inside the map content builder, `MapPolyline(coordinates:).stroke(_:lineWidth:)`,
   `Annotation(_:coordinate:anchor:)`, `.mapControls { MapCompass(); MapScaleView() }`.
3. **App Intents metadata** (checked by Xcode's extractor at build time, not by any compiler) —
   `Shared/Intents/HermesIntents.swift` (computed `static var title/description`, `ParameterSummary`,
   `@Parameter(title:default:)`), `Shared/Intents/AppOnly/HermesShortcuts.swift` (every phrase contains
   `\(.applicationName)`; the only parameter in a phrase is the `FeelLevel` AppEnum). Errors here show as
   "Invalid phrase"/metadata build errors.
4. **iOS 18 control** — `Widgets/QuickAddControl.swift` + `Widgets/HermesWidgets.swift` (`ControlWidget` inside
   the `WidgetBundle` under `if #available(iOS 18.0, *)`), `OpenQuickAddIntent` (`OpenURLIntent(hermes://new)`;
   if the custom scheme does not open from a control, the intent also hands the link to `IntentNavigator`).
5. **Concurrency diagnostics** (warnings in the project's Swift 5 mode) — `App/Core/HermesApp.swift`
   (`.backgroundTask(.appRefresh)` `@Sendable` closure), `Widgets/Timeline/SnapshotLoader.swift`
   (TimelineProvider completion handlers), `Shared/Intents/HermesIntents.swift` (`@MainActor` `perform`).
   The stubs model Xcode 16's `@MainActor View`; the code is clean under `-strict-concurrency=complete`
   against them, but the real SDK's annotations differ in detail between Xcode versions.
6. **"Unable to type-check this expression in reasonable time"** — the largest `body`s:
   `App/Features/Journal/JournalScreen.swift`, `Settings/GarminScreen.swift`, `Calendar/MoveWorkoutScreen.swift`,
   `Activities/ActivityScreen.swift`, `Activities/ActivitiesScreen.swift` (150–210 ms each against the stubs;
   real SwiftUI has more overloads). Fix by extracting a subview.
7. **`@Observable` on a generic class** (`App/Core/Remote.swift`) — expanded by the real Observation macro on
   Linux (Swift 6.2.1); Xcode 16.0–16.2 ship Swift 6.0, whose macro is older.
8. Not compile-time: Keychain sharing (`KeychainTokenStore`, Apple-only), App Group container, background
   refresh scheduling and widget reload budgets only work on a signed build on a device.

## Connect to your server

Hermes is self-hosted, so the first screen asks for your server's address (your Worker, e.g.
`hermes.yourname.workers.dev`) and its passphrase. The address is saved in the App Group (`ServerStore`)
so the widgets and App Intents use the same server, and pre-fills the screen the next time you sign in.
A build may carry a default (`HERMES_SERVER_URL` → Info.plist `HermesServerURL`); a saved address wins.
After signing in the app opens straight into the tabs on every launch; only a 401 from the server
(device revoked, passphrase changed) or "Sign out" brings the passphrase screen back. Offline,
timeouts and 5xx keep the cached data on screen ("Offline — showing saved data") and are retried with
backoff, when the network path returns (NWPathMonitor) and when the app comes to the foreground.

Local development (Debug builds only; compiled out of Release, whose Info.plist also drops the
local-network ATS exception): launch with `-HermesDebugServerURL http://localhost:5240` (or env
`HERMES_DEBUG_SERVER_URL`); the app shares it with the widgets through the App Group. Run the web app
(`cd apps/web && pnpm dev`, seeded demo passphrase `hermes-demo`). Plain HTTP is allowed only for
localhost, `*.local` and private-network addresses.

UI test (`HermesUITests`, simulator): sign-in, relaunch, offline/recovery and revocation against a
local server — pass `TEST_RUNNER_HERMES_UITEST_SERVER_URL`, `TEST_RUNNER_HERMES_UITEST_PASSPHRASE`,
optionally `TEST_RUNNER_HERMES_UITEST_CONTROL_URL` (a switchable proxy with `/down` and `/up`) and
`TEST_RUNNER_HERMES_UITEST_SCREENSHOTS`, to `xcodebuild … -scheme Hermes test`.

The app exchanges the passphrase for a device token (`POST /api/auth/devices`) and keeps it in the
shared keychain; the passphrase is not stored. The token expires 30 days after sign-in (server-side);
the next request then gets a 401 and the app shows the passphrase screen, like a revocation. Sign out (More → "Sign out of this iPhone") revokes the
token on the server and removes everything the phone keeps for the account: the token, the snapshot and
cached responses (app and widget), and the widget's check-in record; the widgets then show "Connect in
the app". Revoking the device from the web app, or changing the passphrase, does the same on the
phone's next request (HTTP 401).

## CadenceKit on its own

```
cd apps/ios/CadenceKit
swift build && swift test                       # unit tests: formatting, decoding every fixture, widget models, client
HERMES_BASE_URL=http://localhost:5240 HERMES_PASSPHRASE=hermes-demo swift test --filter IntegrationTests
```

Works on macOS and on Linux (swift.org toolchain; networking via FoundationNetworking). The
integration suite creates its own device, reads every endpoint, performs reversible writes and
revokes the token — run it against a dev/demo server.

`scripts/typecheck-stubs.sh` (needs a Swift toolchain, no Xcode) type-checks the app and widget
targets against the stub SDK in `scripts/stubs/`; see "Verified vs unverified".

Tools that need only Python 3 (no Swift):

| script | what it does |
|---|---|
| `scripts/capture_fixtures.py --base URL [--out DIR] [--writes]` | logs in (device token, cookie fallback), saves trimmed real responses of every endpoint to `CadenceKit/Tests/CadenceKitTests/Fixtures/` (per sport it keeps the richest activity: located outdoor sessions and pool swims first; `--writes` only on a throwaway DB) |
| `scripts/check_fixtures.py [--strict]` | parses the Swift models into `CadenceKit/models.manifest.json` and checks every fixture field by field (required vs optional, JSON types, integer fields, enum values, unmodelled keys) |
| `scripts/contract_smoke.py --base URL` | replays the integration suite's 53 requests with the exact paths and bodies `Endpoints` builds and checks each response against the Swift types |
| `scripts/make_assets.py` | converts the web OKLCH tokens (apps/web/src/styles/app.css) to sRGB colour sets, `Shared/Palette.generated.swift` and the app icon (Pillow) |

## Verified vs unverified

Everything below runs with one command on Linux (or macOS): `SWIFT_BIN=… scripts/linux-test.sh`
(add `HERMES_BASE_URL` + `HERMES_PASSPHRASE` for the live parts).

**Verified on Linux** with the swift.org 6.2.1 toolchain (2026-11-22):
- `swift build` of CadenceKit is clean (tools 5.9, Swift 5 language mode), and clean in Swift 6 language
  mode with `-strict-concurrency=complete -warnings-as-errors`.
- `swift test`: **157 tests, 0 failures** — 154 unit tests (formatting, dates, every fixture decodes, the
  app/analysis/widget view-models, client behaviour with a mock transport, caches) plus the 3 live
  IntegrationTests against the freshly seeded demo server on port 5240 (device token → every read
  endpoint → reversible writes → revoked token gets 401).
- `check_fixtures.py --strict`: 50 real fixtures vs 121 model structs / 45 enums, 0 errors, 0 warnings.
  The activity fixtures were re-captured from that server and include `locationName`, `facts`,
  `swimLengths` and the detailed lap fields.
- `contract_smoke.py`: the client's request sequence replayed from Python, 53 requests, 0 failures.
- **Stub type-check of both SwiftUI targets** (`scripts/typecheck-stubs.sh`): every Swift file of the app
  target (`App/**` + `Shared/**`, 41 files) and of the widget extension (`Widgets/**` + `Shared/**` minus
  `Shared/Intents/AppOnly`, 18 files) — the same membership as `project.yml` — passes
  `swiftc -typecheck` with **0 errors and 0 warnings**, in Swift 5 mode and with
  `-strict-concurrency=complete` (also clean in Swift 6 mode), against the real CadenceKit module and stub
  modules for SwiftUI, Charts, MapKit, WidgetKit, AppIntents, Combine, UIKit, BackgroundTasks and
  CoreLocation (`scripts/stubs/`, ~3,000 lines, written from the iOS 17 SDK signatures; iOS 18 APIs are
  marked). `#Preview` bodies are type-checked too (rewritten to stub calls). The script also checks that
  every iOS 18 API is used under an iOS 18 availability guard and that every Swift file belongs to a target.
  The stubs are deliberately strict where it is cheap (≤ 10 children per view builder, no `for` in
  builders, no UIKit re-export, `WidgetBundle` `if` only with `#available`), and were probed with
  known-bad code to make sure they reject it.

**What the stub type-check does not prove:** that `scripts/stubs/` matches Apple's SDK exactly (labels,
generic constraints, overload sets, actor annotations), App Intents metadata validity, asset catalogs,
Info.plist/entitlements, signing, or anything at run time. Availability is only checked textually (the
Linux compiler ignores `@available(iOS …)`).

**Not verified (needs a Mac):** an Xcode build, `xcodegen`, signing, App Group / keychain sharing between
app and widget, the Keychain implementation (`Security` is Apple-only), background refresh, Siri phrases,
and how the screens and widgets look and behave. See "Known risks" above and the device checklist in
`Widgets/README.md`.
