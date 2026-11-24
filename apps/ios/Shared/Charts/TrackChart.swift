import SwiftUI
import Charts
import CadenceKit

/// Data colour per stream metric (DESIGN_V2 §8): power blue, heart rate red, pace/speed aqua,
/// cadence violet, elevation neutral.
enum StreamColor {
    static func color(_ metric: StreamMetric, accent: Accent) -> Color {
        switch metric {
        case .power: return DataColor.zone(2)
        case .heartRate: return DataColor.zone(5)
        case .pace, .speed: return DataColor.zone(3)
        case .cadence: return DataColor.zone(6)
        case .elevation: return Theme.colors(accent).fg3
        }
    }
}

/// One activity stream as a line (Swift Charts), with an optional faint elevation area behind it
/// and a shared scrubbing selection: the rule + in-chart label follow the finger on the touched
/// chart and are mirrored on its siblings (`chartScrub`, Shared/Charts/ChartScrub.swift).
/// Fixed height; never resizes on load.
@MainActor
struct TrackChart: View {
    let model: StreamChartModel
    let track: StreamTrack
    var height: CGFloat = 120
    var showsXAxis: Bool = true
    var showsElevation: Bool = false
    @Binding var selection: Double?
    @Environment(\.hermesAccent) private var accent

    var body: some View {
        let c = Theme.colors(accent)
        let color = StreamColor.color(track.metric, accent: accent)
        let label = selection.flatMap { model.scrubLabel(track.metric, at: $0) }
        let backdrop = showsElevation ? model.elevationBackdrop(in: track.yDomain) : (base: track.yDomain.lowerBound, points: [StreamPoint]())
        Chart {
            ForEach(backdrop.points, id: \.x) { p in
                AreaMark(x: .value("Time", p.x),
                         yStart: .value("Base", backdrop.base),
                         yEnd: .value("Elevation", p.y))
                    .foregroundStyle(c.fg4.opacity(0.18))
                    .interpolationMethod(.monotone)
            }
            ForEach(track.points, id: \.x) { p in
                LineMark(x: .value("Time", p.x),
                         y: .value(track.label, p.y),
                         series: .value("Segment", p.segment))
                    .foregroundStyle(color)
                    .lineStyle(StrokeStyle(lineWidth: track.isPrimary ? 1.8 : 1.3, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.monotone)
            }
            if let x = label?.x ?? selection {
                RuleMark(x: .value("Selected", x))
                    .foregroundStyle(c.fg2)
                    .lineStyle(StrokeStyle(lineWidth: 1))
            }
            if let label, let y = label.plotY {
                PointMark(x: .value("Selected", label.x), y: .value(track.label, y))
                    .symbolSize(36)
                    .foregroundStyle(color)
            }
        }
        .chartXScale(domain: model.xDomain)
        .chartYScale(domain: track.yDomain)
        .chartLegend(.hidden)
        .hermesAxes(xTicks: model.xTicks, yTicks: track.yTicks, showsX: showsXAxis, accent: accent)
        .chartScrub(selection: $selection, anchor: label?.x, label: label)
        .frame(height: height)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(model.accessibilitySummary(track)))
        .accessibilityValue(Text(label?.accessibilityText ?? ""))
        .accessibilityIdentifier("chart-\(track.metric.rawValue)")
    }
}
