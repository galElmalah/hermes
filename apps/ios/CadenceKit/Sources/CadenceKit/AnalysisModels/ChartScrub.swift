import Foundation

// In-chart scrub labels: what the small label at the finger says, and where it goes. The SwiftUI
// side measures the label and asks `ScrubLabelPlacement.place` for its origin, so the geometry
// (stay inside the plot, flip sides near an edge, keep clear of the fingertip) is tested here.

/// The small opaque label drawn at the scrub position inside a chart.
public struct ChartScrubLabel: Hashable, Sendable {
    public struct Item: Hashable, Sendable, Identifiable {
        public var id: String { (label ?? "") + "|" + value + "|" + unit }
        /// "Fitness" — nil when the chart itself names the series (stream tracks)
        public var label: String?
        /// "245", "4:10", "7:36 h"
        public var value: String
        /// "W", "/km"; empty when `value` already carries it
        public var unit: String

        public init(label: String? = nil, value: String, unit: String = "") {
            self.label = label
            self.value = value
            self.unit = unit
        }

        public var text: String {
            var s = label.map { $0 + " " } ?? ""
            s += value
            if !unit.isEmpty { s += Format.unitSpace + unit }
            return s
        }
    }

    /// the x (in chart units) the rule and the label belong to — the nearest real sample
    public var x: Double
    /// one or more values, shown on the first line
    public var items: [Item]
    /// "1:05:20 · 28.4 km", "Sat 21 Nov", "Week of 16 Nov" — where along the x axis
    public var position: String
    /// plotted y of the series at `x` (for a dot on the line); nil when it has no value there
    public var plotY: Double?

    public init(x: Double, items: [Item], position: String, plotY: Double? = nil) {
        self.x = x
        self.items = items
        self.position = position
        self.plotY = plotY
    }

    public var accessibilityText: String {
        ([position] + items.map(\.text)).joined(separator: ", ")
    }
}

/// Where the scrub label sits inside the plot area (all values in points, origin top-left).
public struct ScrubLabelPlacement: Hashable, Sendable {
    public enum Side: String, Hashable, Sendable { case trailing, leading }

    /// top-left corner of the label
    public var x: Double
    public var y: Double
    /// which side of the rule the label is on
    public var side: Side

    public init(x: Double, y: Double, side: Side) {
        self.x = x
        self.y = y
        self.side = side
    }

    /// The label normally sits at the top of the plot, just right of the rule. Near the right edge it
    /// flips to the left of the rule; when neither side has room it is clamped inside the plot.
    /// While a finger touches this chart and is inside the label's top band, the label moves
    /// sideways by at least `fingerClearance` so the fingertip does not cover it (above the finger
    /// is always visible; below it is hidden by the hand).
    ///
    /// - Parameters:
    ///   - anchorX: x of the rule
    ///   - fingerY: y of the touch on this chart; nil on the sibling charts that mirror the position
    ///   - gap: space between the rule and the label
    public static func place(anchorX: Double, fingerY: Double?, labelWidth: Double, labelHeight: Double,
                             boundsWidth: Double, boundsHeight: Double,
                             gap: Double = 8, fingerClearance: Double = 26) -> ScrubLabelPlacement {
        let bw = max(0, boundsWidth), bh = max(0, boundsHeight)
        let w = min(max(0, labelWidth), bw), h = min(max(0, labelHeight), bh)
        let ax = min(bw, max(0, anchorX))

        var offset = gap
        let y: Double = 0
        if let fy = fingerY, fy < h + fingerClearance {
            // the fingertip is in the label's band: move the label clear of it, sideways
            offset = max(gap, fingerClearance)
        }

        var side = Side.trailing
        var x = ax + offset
        if x + w > bw {
            side = .leading
            x = ax - offset - w
        }
        if x < 0 {
            // no room on either side: take the roomier side and clamp inside the plot
            if ax >= bw / 2 {
                side = .leading
                x = 0
            } else {
                side = .trailing
                x = bw - w
            }
        }
        x = min(max(0, x), max(0, bw - w))
        return ScrubLabelPlacement(x: x, y: min(max(0, y), max(0, bh - h)), side: side)
    }
}

extension ChartMath {
    /// Index of the sample nearest to `x` that has a value, looking at most `maxDistance` away
    /// (in x units) from `x`. nil when every sample in reach is missing. `xs` must be sorted.
    public static func nearestValueIndex(_ xs: [Double], _ values: [Double?], to x: Double, maxDistance: Double) -> Int? {
        let n = min(xs.count, values.count)
        guard n > 0, let start = nearestIndex(Array(xs.prefix(n)), to: x) else { return nil }
        if values[start] != nil { return start }
        var lo = start - 1, hi = start + 1
        while lo >= 0 || hi < n {
            let dl = lo >= 0 ? abs(xs[lo] - x) : .infinity
            let dh = hi < n ? abs(xs[hi] - x) : .infinity
            if min(dl, dh) > maxDistance { return nil }
            if dl <= dh {
                if values[lo] != nil { return lo }
                lo -= 1
            } else {
                if values[hi] != nil { return hi }
                hi += 1
            }
        }
        return nil
    }
}
