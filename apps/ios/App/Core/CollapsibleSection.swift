import SwiftUI
import CadenceKit

/// A section whose header opens and closes it: title, a one-line summary while closed, and a
/// chevron that turns. The open/closed state is remembered per section in the App Group defaults
/// (`SectionStateStore`); defaults come from `DetailSection.defaultExpanded` (essentials open,
/// details closed) unless the screen passes its own.
@MainActor
struct CollapsibleSection<Content: View>: View {
    let section: DetailSection
    let title: String
    var summary: String? = nil
    var defaultExpanded: Bool? = nil
    let content: Content
    @Environment(AppModel.self) private var model
    @Environment(\.hermesAccent) private var accent
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// nil until the first toggle on this screen: read from the store
    @State private var expanded: Bool? = nil

    init(_ section: DetailSection, title: String, summary: String? = nil, defaultExpanded: Bool? = nil,
         @ViewBuilder content: () -> Content) {
        self.section = section
        self.title = title
        self.summary = summary
        self.defaultExpanded = defaultExpanded
        self.content = content()
    }

    var body: some View {
        let c = Theme.colors(accent)
        let isOpen = expanded ?? model.sections.isExpanded(section, default: defaultExpanded)
        VStack(alignment: .leading, spacing: Theme.Space.s) {
            Button {
                let next = !isOpen
                model.sections.setExpanded(next, for: section)
                withAnimation(Theme.Motion.resolved(Theme.Motion.snappy, reduceMotion: reduceMotion)) { expanded = next }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Space.xs) {
                    Text(title)
                        .font(Theme.Typography.title3)
                        .foregroundStyle(c.fg1)
                        .lineLimit(1)
                        .layoutPriority(1)
                    Spacer(minLength: Theme.Space.xs)
                    if !isOpen, let summary, !summary.isEmpty {
                        Text(summary)
                            .font(Theme.Typography.bodySmall.monospacedDigit())
                            .foregroundStyle(c.fg3)
                            .lineLimit(1)
                            .transition(.opacity)
                    }
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(c.fg3)
                        .rotationEffect(.degrees(isOpen ? 90 : 0))
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(title))
            .accessibilityValue(Text(isOpen ? "Expanded" : "Collapsed" + (summary.map { ", " + $0 } ?? "")))
            .accessibilityHint(Text(isOpen ? "Double-tap to hide the details" : "Double-tap to show the details"))
            .accessibilityAddTraits([.isHeader, .isButton])
            .accessibilityIdentifier("section-\(section.rawValue)")
            .sensoryFeedback(.selection, trigger: expanded)

            if isOpen {
                content
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
