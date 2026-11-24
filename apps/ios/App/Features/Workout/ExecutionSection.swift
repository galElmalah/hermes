import SwiftUI
import CadenceKit

/// "Execution" — how a completed session followed its plan (activity and workout pages): the
/// adherence score (0–100) with its one-line summary, then every step with planned vs actual, a
/// verdict and the signed deviation. Over and under differ by arrow, word and sign (colour only
/// adds to that). Hidden by the caller when the server sends no usable analysis.
@MainActor
struct ExecutionSection: View {
    let model: ExecutionModel
    let section: DetailSection
    /// activity page: a link to the planned workout
    var plannedWorkout: (id: String, title: String)? = nil
    @Environment(\.hermesAccent) private var accent

    var body: some View {
        let c = Theme.colors(accent)
        CollapsibleSection(section, title: "Execution", summary: "\(model.scoreText)/100\(Format.dot)\(model.stateLabel)") {
            VStack(alignment: .leading, spacing: Theme.Space.m) {
                headline(c)
                if !model.steps.isEmpty {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(model.steps) { row in
                            ExecutionStepRowView(row: row)
                            if row.id != model.steps.last?.id {
                                Rectangle().fill(c.line1).frame(height: 0.5).padding(.leading, 30)
                            }
                        }
                    }
                }
                if let method = model.methodText {
                    Text(method)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(c.fg4)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func headline(_ c: ThemeColors) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Space.xs) {
                Text(model.scoreText)
                    .font(Theme.Typography.statLarge)
                    .foregroundStyle(c.fg1)
                    .contentTransition(.numericText(value: model.score))
                Text("/100 adherence")
                    .font(Theme.Typography.bodySmall)
                    .foregroundStyle(c.fg3)
                Spacer(minLength: Theme.Space.xs)
                Image(systemName: model.tone.symbol)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(toneColor(model.tone, c))
                    .accessibilityHidden(true)
                Text(model.stateLabel)
                    .font(Theme.Typography.body.weight(.semibold))
                    .foregroundStyle(c.fg1)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(model.accessibilityLabel))
            ThinProgressBar(fraction: model.score / 100)
            if !model.summary.isEmpty {
                Text(model.summary)
                    .font(Theme.Typography.body)
                    .foregroundStyle(c.fg2)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHidden(true)
            }
            let small = [model.countsText, model.totalsText].compactMap { $0 }
            if !small.isEmpty {
                Text(small.joined(separator: "\n"))
                    .font(Theme.Typography.caption.monospacedDigit())
                    .foregroundStyle(c.fg3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let plan = plannedWorkout {
                NavigationLink(value: Route.workout(id: plan.id)) {
                    HStack(spacing: Theme.Space.xxs) {
                        Text("Planned: \(plan.title)")
                            .font(Theme.Typography.bodySmall)
                            .foregroundStyle(c.fg2)
                            .lineLimit(1)
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(c.fg3)
                            .accessibilityHidden(true)
                    }
                    .padding(.vertical, Theme.Space.xxs)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the planned workout")
            }
        }
    }
}

/// One step: verdict mark · label / plan / did / the server's deviation words; verdict word and
/// signed figure on the right.
@MainActor
struct ExecutionStepRowView: View {
    let row: ExecutionStepRow
    @Environment(\.hermesAccent) private var accent

    var body: some View {
        let c = Theme.colors(accent)
        let color = verdictColor(row.verdict, c)
        HStack(alignment: .top, spacing: Theme.Space.s) {
            Image(systemName: row.verdict.symbol)
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(color)
                .frame(width: 20, height: 20)
                .background(color.opacity(0.14), in: Circle())
                .padding(.top, 1)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Space.xs) {
                    Text(row.label)
                        .font(Theme.Typography.body)
                        .foregroundStyle(row.isEasy ? c.fg2 : c.fg1)
                        .lineLimit(1)
                    Spacer(minLength: Theme.Space.xs)
                    Text(row.verdict.label)
                        .font(Theme.Typography.bodySmall)
                        .foregroundStyle(c.fg2)
                    if let signed = row.signedDeviation {
                        Text(signed)
                            .font(Theme.Typography.bodySmall.monospacedDigit().weight(.semibold))
                            .foregroundStyle(c.fg1)
                    }
                }
                if let planned = row.plannedText {
                    line("Plan", planned, c.fg3, c)
                }
                if let actual = row.actualText {
                    line("Did", actual, c.fg2, c)
                }
                if let words = row.deviationText {
                    Text(words)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(c.fg3)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, Theme.Space.xs)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(row.accessibilityLabel))
    }

    private func line(_ title: String, _ value: String, _ color: Color, _ c: ThemeColors) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Theme.Space.xs) {
            Text(title)
                .font(Theme.Typography.caption)
                .foregroundStyle(c.fg4)
                .frame(width: 28, alignment: .leading)
            Text(value)
                .font(Theme.Typography.caption.monospacedDigit())
                .foregroundStyle(color)
                .lineLimit(2)
        }
    }

    /// Always paired with the arrow/word: on target good, over warm (orange), under cool (blue),
    /// skipped critical, extra neutral.
    private func verdictColor(_ v: ExecutionVerdict, _ c: ThemeColors) -> Color {
        switch v {
        case .onTarget: return DataColor.good
        case .over: return DataColor.serious
        case .under: return DataColor.zone(2)
        case .skipped: return DataColor.critical
        case .extra, .unknown: return c.fg3
        }
    }
}
