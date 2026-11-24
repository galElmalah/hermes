import SwiftUI
import Charts
import UIKit
import CadenceKit

// Scrubbing a chart with a finger: a vertical rule plus a small opaque label at the finger
// (value + unit, and where along the x axis), mirrored on sibling charts that share the selection.
//
// Scrolling vs scrubbing: the touch surface is a UIKit view with its own pan recogniser that only
// begins for a mostly-horizontal drag, and the enclosing UIScrollView's pan waits for it to fail.
// A vertical drag therefore scrolls the page immediately; a horizontal drag scrubs (and the page
// does not move). A touch held still for a moment also scrubs, in any direction, after that.
// The label's geometry (inside the plot, flip near edges, clear of the fingertip) is
// `ScrubLabelPlacement` in CadenceKit.

extension View {
    /// Adds scrubbing to a Swift Charts chart.
    /// - Parameters:
    ///   - selection: shared x selection (nil when nobody is scrubbing)
    ///   - anchor: the x the rule and label belong to (usually the selection snapped to a sample)
    ///   - label: what the label at the rule says; nil hides it
    ///   - sticky: keep the selection after the finger lifts (and select/deselect with a tap), for
    ///     charts whose selection offers an action (weekly volume → "Review")
    func chartScrub<X: Plottable & Equatable>(selection: Binding<X?>, anchor: X?, label: ChartScrubLabel?,
                                              sticky: Bool = false) -> some View {
        chartOverlay(alignment: .topLeading) { proxy in
            ChartScrubOverlay(proxy: proxy, selection: selection, anchor: anchor, label: label, sticky: sticky)
        }
    }
}

@MainActor
private struct ChartScrubOverlay<X: Plottable & Equatable>: View {
    let proxy: ChartProxy
    @Binding var selection: X?
    let anchor: X?
    let label: ChartScrubLabel?
    let sticky: Bool
    /// finger position on THIS chart (nil on sibling charts that mirror the selection)
    @State private var fingerY: CGFloat? = nil

    var body: some View {
        GeometryReader { geo in
            if let plotAnchor = proxy.plotFrame {
                let plot = geo[plotAnchor]
                ZStack(alignment: .topLeading) {
                    ScrubTouchSurface(onChange: { p in update(p, width: plot.width) }, onEnd: end,
                                      onTap: sticky ? { p in tap(p, width: plot.width) } : nil)
                    if let label, let anchor, let x = proxy.position(forX: anchor) {
                        ScrubLabelLayout(anchorX: x, fingerY: fingerY) {
                            ScrubLabelView(label: label)
                        }
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                    }
                }
                .frame(width: plot.width, height: plot.height)
                .offset(x: plot.minX, y: plot.minY)
            }
        }
    }

    private func value(_ p: CGPoint, width: CGFloat) -> X? {
        proxy.value(atX: min(max(0, p.x), max(0, width - 0.5)), as: X.self)
    }

    private func update(_ p: CGPoint, width: CGFloat) {
        fingerY = p.y
        if let v = value(p, width: width), v != selection {
            selection = v
        }
    }

    private func end() {
        fingerY = nil
        if !sticky { selection = nil }
    }

    private func tap(_ p: CGPoint, width: CGFloat) {
        let v = value(p, width: width)
        selection = v == selection ? nil : v
    }
}

/// Places its single subview with `ScrubLabelPlacement` (measured, so no first-frame jump).
private struct ScrubLabelLayout: Layout {
    var anchorX: CGFloat
    var fingerY: CGFloat?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let label = subviews.first else { return }
        let size = label.sizeThatFits(.unspecified)
        let p = ScrubLabelPlacement.place(anchorX: Double(anchorX), fingerY: fingerY.map(Double.init),
                                          labelWidth: Double(size.width), labelHeight: Double(size.height),
                                          boundsWidth: Double(bounds.width), boundsHeight: Double(bounds.height))
        label.place(at: CGPoint(x: bounds.minX + CGFloat(p.x), y: bounds.minY + CGFloat(p.y)), anchor: .topLeading,
                    proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
    }
}

/// The small opaque label: values on the first line (unit in fg3), the x position below.
@MainActor
struct ScrubLabelView: View {
    let label: ChartScrubLabel
    @Environment(\.hermesAccent) private var accent

    var body: some View {
        let c = Theme.colors(accent)
        VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                ForEach(label.items) { item in
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        if let name = item.label {
                            Text(name).foregroundStyle(c.fg3)
                        }
                        Text(item.value)
                            .fontWeight(.semibold)
                            .foregroundStyle(c.fg1)
                        if !item.unit.isEmpty {
                            Text(item.unit).foregroundStyle(c.fg3)
                        }
                    }
                }
            }
            .font(Theme.Typography.caption.monospacedDigit())
            Text(label.position)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(c.fg2)
        }
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(c.surface2, in: RoundedRectangle(cornerRadius: Theme.Radius.small, style: .continuous))
        .shadow(color: .black.opacity(0.14), radius: 3, x: 0, y: 1)
    }
}

/// The UIKit touch surface (see the note at the top of the file).
private struct ScrubTouchSurface: UIViewRepresentable {
    var onChange: (CGPoint) -> Void
    var onEnd: () -> Void
    var onTap: ((CGPoint) -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handle(_:)))
        pan.delegate = context.coordinator
        pan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(pan)
        let hold = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handle(_:)))
        hold.minimumPressDuration = 0.3
        hold.allowableMovement = 8
        hold.delegate = context.coordinator
        view.addGestureRecognizer(hold)
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
        view.addGestureRecognizer(tap)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onChange = onChange
        context.coordinator.onEnd = onEnd
        context.coordinator.onTap = onTap
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onChange: (CGPoint) -> Void = { _ in }
        var onEnd: () -> Void = {}
        var onTap: ((CGPoint) -> Void)? = nil
        private var active = Set<ObjectIdentifier>()
        private let haptics = UIImpactFeedbackGenerator(style: .light)

        @objc func handle(_ g: UIGestureRecognizer) {
            let id = ObjectIdentifier(g)
            switch g.state {
            case .began:
                if active.isEmpty { haptics.impactOccurred() }
                active.insert(id)
                onChange(g.location(in: g.view))
            case .changed:
                onChange(g.location(in: g.view))
            case .ended, .cancelled, .failed:
                active.remove(id)
                if active.isEmpty { onEnd() }
            default:
                break
            }
        }

        @objc func tapped(_ g: UITapGestureRecognizer) {
            guard g.state == .ended, let onTap else { return }
            onTap(g.location(in: g.view))
        }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            if g is UITapGestureRecognizer { return onTap != nil }
            guard let pan = g as? UIPanGestureRecognizer else { return true }
            // a held touch already scrubs; otherwise only a mostly-horizontal drag does
            if !active.isEmpty { return true }
            let v = pan.velocity(in: pan.view)
            return abs(v.x) > abs(v.y)
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            other.view === g.view // our pan and hold work together
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            // the page's scroll pan waits until our pan has decided (vertical → we fail at once)
            guard g is UIPanGestureRecognizer, let scroll = other.view as? UIScrollView else { return false }
            return other === scroll.panGestureRecognizer
        }

        override init() {
            super.init()
            haptics.prepare()
        }
    }
}
