import SwiftUI
import UIKit
import CadenceKit

/// First run (and after the token was revoked): the address of your own Hermes server (a Cloudflare
/// Workers deployment) and its passphrase → device token (docs/MOBILE_API.md §1). The address is
/// pre-filled with the last server used (or the build's default); the device is named after the
/// phone. Clear error states: bad address, wrong passphrase, throttled with a live countdown, unreachable.
@MainActor
struct ConnectScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.hermesAccent) private var accent
    @State private var address = ConnectForm.displayAddress(HermesServer.baseURL)
    @State private var passphrase = ""
    @State private var busy = false
    @State private var failure: ConnectFailure? = nil
    @State private var failedAt = Date()
    @State private var attempts = 0
    @FocusState private var focus: ConnectField?

    var body: some View {
        let c = Theme.colors(accent)
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.l) {
                VStack(alignment: .leading, spacing: Theme.Space.xs) {
                    Text("hermes")
                        .font(Theme.Typography.title1)
                        .foregroundStyle(c.fg1)
                        .accessibilityAddTraits(.isHeader)
                    Text("Connect to your Hermes server.")
                        .font(Theme.Typography.body)
                        .foregroundStyle(c.fg2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, Theme.Space.xl)

                field("Server", highlighted: failure?.field == .server) {
                    TextField("your-hermes.workers.dev", text: $address)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.next)
                        .focused($focus, equals: .server)
                        .onSubmit { focus = .passphrase }
                        .accessibilityIdentifier("server")
                }

                field("Passphrase", highlighted: failure?.field == .passphrase) {
                    SecureField("Your Hermes passphrase", text: $passphrase)
                        .textContentType(.password)
                        .submitLabel(.go)
                        .focused($focus, equals: .passphrase)
                        .onSubmit(connect)
                        .accessibilityIdentifier("passphrase")
                }

                if let failure {
                    // re-renders every second while throttled, so the countdown ticks
                    TimelineView(.periodic(from: failedAt, by: 1)) { context in
                        failureLine(failure, now: context.date)
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }

                TimelineView(.periodic(from: failedAt, by: 1)) { context in
                    let blocked = failure?.blocksRetry(now: context.date) ?? false
                    Button(action: connect) {
                        ZStack {
                            Text("Sign in").opacity(busy ? 0 : 1)
                            if busy { ProgressView().tint(c.onAccent) }
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(busy || blocked || !ConnectForm.canSubmit(server: address, passphrase: passphrase))
                    .accessibilityIdentifier("sign-in")
                }

                Text("The server is the address of your Hermes deployment (for example hermes.yourname.workers.dev). Use the passphrase from its web app. This iPhone gets its own token for 30 days, which you can revoke in the web app\u{2019}s settings. The passphrase itself is not stored.")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(c.fg3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, Theme.Space.gutter)
            .padding(.bottom, Theme.Space.xxl)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(c.canvas.ignoresSafeArea())
        .animation(Theme.Motion.snappy, value: failure)
        .sensoryFeedback(.error, trigger: attempts)
        .onAppear { focus = address.isEmpty ? .server : .passphrase }
    }

    private func failureLine(_ f: ConnectFailure, now: Date) -> some View {
        let c = Theme.colors(accent)
        let symbol: String
        switch f {
        case .throttled: symbol = "hourglass"
        case .unreachable(let offline): symbol = offline ? "wifi.slash" : "network.slash"
        case .wrongPassphrase: symbol = "key"
        case .invalidAddress: symbol = "link"
        default: symbol = "exclamationmark.circle"
        }
        return Label {
            Text(f.message(now: now))
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.numericText())
        } icon: {
            Image(systemName: symbol).foregroundStyle(f == .wrongPassphrase ? DataColor.critical : DataColor.warn)
        }
        .font(Theme.Typography.bodySmall)
        .foregroundStyle(c.fg1)
        .accessibilityElement(children: .combine)
    }

    private func field<Content: View>(_ label: String, highlighted: Bool, @ViewBuilder content: () -> Content) -> some View {
        let c = Theme.colors(accent)
        return VStack(alignment: .leading, spacing: Theme.Space.xs) {
            Text(label)
                .font(Theme.Typography.label)
                .foregroundStyle(c.fg3)
            content()
                .font(Theme.Typography.body)
                .foregroundStyle(c.fg1)
                .padding(.horizontal, Theme.Space.s)
                .frame(minHeight: 48)
                .background(c.surface1, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous)
                        .strokeBorder(highlighted ? c.line3 : Color.clear, lineWidth: 1)
                )
        }
    }

    private func connect() {
        guard !busy, ConnectForm.canSubmit(server: address, passphrase: passphrase) else { return }
        if let failure, failure.blocksRetry(now: Date()) { return }
        busy = true
        focus = nil
        Task {
            do {
                try await model.connect(address: address, passphrase: passphrase, deviceName: UIDevice.current.name)
                passphrase = ""
                failure = nil
            } catch let e as APIError {
                failedAt = Date()
                failure = ConnectFailure(e, now: failedAt)
                attempts += 1
                if let field = failure?.field { focus = field }
            } catch {
                failedAt = Date()
                failure = .other(error.localizedDescription)
                attempts += 1
            }
            busy = false
        }
    }
}
