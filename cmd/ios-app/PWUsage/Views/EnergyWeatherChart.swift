import Charts
import SwiftUI

/// "Charge later" (thick, solid) and "Charge now" (thin, faint, dashed), or a
/// single "Charge now" line when starting now is cheapest.
struct EnergyWeatherLegend: View {
    let verdict: SmartShiftVerdict

    private var hasTwoLines: Bool { verdict.lanes.contains { $0.startNow != nil } }

    var body: some View {
        HStack(spacing: 14) {
            if hasTwoLines {
                item(verdict.laterLabel, style: EnergyWeatherChart.laterStroke, color: SmartShiftCostBars.laterColor)
                item(verdict.nowLabel, style: EnergyWeatherChart.nowStroke, color: EnergyWeatherChart.nowColor)
            } else {
                item(verdict.nowLabel, style: EnergyWeatherChart.laterStroke, color: SmartShiftCostBars.laterColor)
            }
        }
        .font(.caption)
        .accessibilityHidden(true)
    }

    private func item(_ label: String, style: StrokeStyle, color: Color) -> some View {
        HStack(spacing: 5) {
            Path { path in
                path.move(to: CGPoint(x: 0, y: 4))
                path.addLine(to: CGPoint(x: 18, y: 4))
            }
            .stroke(color, style: style)
            .frame(width: 18, height: 8)
            Text(label)
        }
    }
}

/// One lane per rate period: that period's bank from now to the end of the
/// comparison, green when banked and orange when owed, with the recommended run
/// drawn thick and starting now drawn faint.
struct EnergyWeatherChart: View {
    let verdict: SmartShiftVerdict
    let timeZone: String

    static let laterStroke = StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round)
    static let nowStroke = StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [4, 3])
    static let nowColor = Color.gray.opacity(0.8)
    static let ruleColor = Color.gray.opacity(0.6)
    static let bankedColor = Color.green
    static let owedColor = Color.orange

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(verdict.lanes.enumerated()), id: \.offset) { index, lane in
                LaneChart(lane: lane, axisDates: verdict.axisDates, timeZone: timeZone, showsSwitchLabels: index == 0)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(verdict.accessibilitySummary)
    }
}

/// Which switch labels fit along the top of a lane without overlapping: each
/// label is centred on its switch and pinned inside the chart, as the chart
/// does, and falls back to its short form, then to none, when it would touch
/// the label before it.
enum SwitchLabelLayout {
    enum Form: Equatable { case full, short, hidden }

    static let gap: CGFloat = 6

    static func place(xs: [CGFloat], fullWidths: [CGFloat], shortWidths: [CGFloat], chartWidth: CGFloat) -> [Form] {
        var lastRight = -CGFloat.infinity
        return xs.indices.map { index in
            for (form, width) in [(Form.full, fullWidths[index]), (.short, shortWidths[index])] where width <= chartWidth {
                let left = min(max(xs[index] - width / 2, 0), chartWidth - width)
                if left >= lastRight + gap {
                    lastRight = left + width
                    return form
                }
            }
            return .hidden
        }
    }
}

private struct LaneChart: View {
    let lane: LaneDisplay
    let axisDates: [Date]
    let timeZone: String
    let showsSwitchLabels: Bool
    @State private var chartWidth: CGFloat = 0

    private var allPoints: [LoadTimingForecastEstimator.BalancePoint] { lane.recommended + (lane.startNow ?? []) }

    private var xDomain: ClosedRange<Date> {
        let dates = allPoints.map(\.date)
        guard let first = dates.min(), let last = dates.max(), last > first else {
            let now = dates.first ?? .now
            return now...now.addingTimeInterval(3600)
        }
        return first...last
    }

    /// Always includes zero so the banked/owed split is visible, with headroom for
    /// end labels, and for the switch labels along the top of the first lane.
    private var yDomain: ClosedRange<Double> {
        let values = allPoints.map(\.kwh) + [0]
        let low = values.min() ?? 0, high = values.max() ?? 0
        // Room above and below the lines for the end labels, so they clear the
        // lines and the axis labels; more on top of the first lane for switch labels.
        let pad = max((high - low) * 0.3, 2)
        let topPad = showsSwitchLabels ? max((high - low) * 0.55, 4) : pad
        return (low - pad)...(high + topPad)
    }

    /// The label each switch can show at the chart's current width (see `SwitchLabelLayout`).
    private var switchLabels: [Date: String] {
        let span = xDomain.upperBound.timeIntervalSince(xDomain.lowerBound)
        guard chartWidth > 0, span > 0 else { return [:] }
        let font = UIFont.preferredFont(forTextStyle: .caption2)
        func width(_ text: String) -> CGFloat { ceil((text as NSString).size(withAttributes: [.font: font]).width) }
        let markers = lane.switches
        let forms = SwitchLabelLayout.place(
            xs: markers.map { CGFloat($0.date.timeIntervalSince(xDomain.lowerBound) / span) * chartWidth },
            fullWidths: markers.map { width($0.label) },
            shortWidths: markers.map { width($0.shortLabel) },
            chartWidth: chartWidth)
        var labels: [Date: String] = [:]
        for (marker, form) in zip(markers, forms) {
            switch form {
            case .full: labels[marker.date] = marker.label
            case .short: labels[marker.date] = marker.shortLabel
            case .hidden: break
            }
        }
        return labels
    }

    private func clock(_ date: Date) -> String {
        DashboardPresentation.date(date, timeZoneIdentifier: timeZone, dateStyle: .none, timeStyle: .short)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(lane.title)
                    .font(.caption.weight(.semibold))
                Spacer()
                Text(lane.startLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            chart
                .frame(height: showsSwitchLabels ? 130 : 110)
                // The y axis is hidden, so the plot spans the chart's width.
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { chartWidth = $0 }
        }
    }

    private var chart: some View {
        let x = xDomain, y = yDomain
        let labels = showsSwitchLabels ? switchLabels : [:]
        return Chart {
            RectangleMark(xStart: .value("Start", x.lowerBound), xEnd: .value("End", x.upperBound),
                          yStart: .value("Zero", 0), yEnd: .value("Top", y.upperBound))
                .foregroundStyle(EnergyWeatherChart.bankedColor.opacity(0.12))
            RectangleMark(xStart: .value("Start", x.lowerBound), xEnd: .value("End", x.upperBound),
                          yStart: .value("Bottom", y.lowerBound), yEnd: .value("Zero", 0))
                .foregroundStyle(EnergyWeatherChart.owedColor.opacity(0.14))
            RuleMark(y: .value("Zero", 0))
                .foregroundStyle(EnergyWeatherChart.ruleColor)
                .lineStyle(StrokeStyle(lineWidth: 1))

            ForEach(Array(lane.switches.enumerated()), id: \.offset) { _, marker in
                RuleMark(x: .value("Switch", marker.date))
                    .foregroundStyle(EnergyWeatherChart.ruleColor)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .annotation(position: .overlay, alignment: .top, spacing: 2,
                                overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                        if let label = labels[marker.date] {
                            Text(label)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .fixedSize()
                                .padding(.top, 2)
                        }
                    }
            }

            if let startNow = lane.startNow {
                ForEach(Array(startNow.enumerated()), id: \.offset) { _, point in
                    LineMark(x: .value("Time", point.date), y: .value("kWh", point.kwh), series: .value("Plan", "now"))
                        .interpolationMethod(.linear)
                        .foregroundStyle(EnergyWeatherChart.nowColor)
                        .lineStyle(EnergyWeatherChart.nowStroke)
                }
            }
            ForEach(Array(lane.recommended.enumerated()), id: \.offset) { _, point in
                LineMark(x: .value("Time", point.date), y: .value("kWh", point.kwh), series: .value("Plan", "later"))
                    .interpolationMethod(.linear)
                    .foregroundStyle(SmartShiftCostBars.laterColor)
                    .lineStyle(EnergyWeatherChart.laterStroke)
            }

            ForEach(Array(endPoints.enumerated()), id: \.offset) { _, end in
                PointMark(x: .value("Time", end.point.date), y: .value("kWh", end.point.kwh))
                    .symbolSize(0)
                    .annotation(position: end.isAbove ? .topLeading : .bottomLeading, spacing: 6,
                                overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                        Text(end.label)
                            .font(.caption2.weight(end.isRecommended ? .bold : .regular))
                            .foregroundStyle(end.isRecommended ? SmartShiftCostBars.laterColor : .secondary)
                    }
            }
        }
        .chartXScale(domain: x)
        .chartYScale(domain: y)
        .chartYAxis(.hidden)
        .chartXAxis {
            AxisMarks(values: axisDates) { value in
                AxisTick()
                AxisValueLabel(collisionResolution: .greedy) {
                    if let date = value.as(Date.self) {
                        Text(clock(date)).font(.caption2)
                    }
                }
            }
        }
        .chartLegend(.hidden)
    }

    private struct EndPoint {
        let point: LoadTimingForecastEstimator.BalancePoint
        let label: String
        let isRecommended: Bool
        /// The higher of two lines takes its label above, the lower one below, so neither sits on a line.
        let isAbove: Bool
    }

    /// One label when both lines end at the same value, else one per line.
    private var endPoints: [EndPoint] {
        guard let later = lane.recommended.last, let laterLabel = lane.endLabels.first else { return [] }
        guard lane.endLabels.count > 1, let now = lane.startNow?.last else {
            return [EndPoint(point: later, label: laterLabel, isRecommended: true, isAbove: true)]
        }
        let laterIsHigher = later.kwh >= now.kwh
        return [EndPoint(point: later, label: laterLabel, isRecommended: true, isAbove: laterIsHigher),
                EndPoint(point: now, label: lane.endLabels[1], isRecommended: false, isAbove: !laterIsHigher)]
    }
}
