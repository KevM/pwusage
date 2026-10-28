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

/// Which halves of each switch label fit along the top of a lane. "← Off-Peak"
/// ends just left of its dashed line and "On-Peak →" starts just right of it, so
/// the boundary is the line itself. A half that would leave the chart or touch
/// the label before it is dropped, never shifted away from its line.
enum SwitchLabelLayout {
    enum Form: Equatable { case both, before, after, hidden }

    /// Space between a half and its line.
    static let inset: CGFloat = 3
    /// Space between neighbouring labels.
    static let gap: CGFloat = 6

    static func place(xs: [CGFloat], beforeWidths: [CGFloat], afterWidths: [CGFloat], chartWidth: CGFloat) -> [Form] {
        var lastRight = -CGFloat.infinity
        return xs.indices.map { index in
            let x = xs[index]
            let before = (x - inset - beforeWidths[index]) ... (x - inset)
            let after = (x + inset) ... (x + inset + afterWidths[index])
            let options: [(Form, [ClosedRange<CGFloat>])] = [(.both, [before, after]), (.after, [after]), (.before, [before])]
            for (form, parts) in options {
                guard parts.allSatisfy({ $0.lowerBound >= 0 && $0.upperBound <= chartWidth }),
                      let first = parts.first, let last = parts.last, first.lowerBound >= lastRight + gap else { continue }
                lastRight = last.upperBound
                return form
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
            return now ... now.addingTimeInterval(3600)
        }
        return first ... last
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
        return (low - pad) ... (high + topPad)
    }

    /// The halves of each switch's label that fit at the chart's current width (see `SwitchLabelLayout`).
    private var switchLabels: [Date: (before: String?, after: String?)] {
        let span = xDomain.upperBound.timeIntervalSince(xDomain.lowerBound)
        guard chartWidth > 0, span > 0 else { return [:] }
        let font = UIFont.preferredFont(forTextStyle: .caption2)
        func width(_ text: String?) -> CGFloat {
            guard let text else { return .infinity }
            return ceil((text as NSString).size(withAttributes: [.font: font]).width)
        }
        let markers = lane.switches
        let forms = SwitchLabelLayout.place(
            xs: markers.map { CGFloat($0.date.timeIntervalSince(xDomain.lowerBound) / span) * chartWidth },
            beforeWidths: markers.map { width($0.beforeLabel) },
            afterWidths: markers.map { width($0.afterLabel) },
            chartWidth: chartWidth)
        var labels: [Date: (before: String?, after: String?)] = [:]
        for (marker, form) in zip(markers, forms) {
            switch form {
            case .both: labels[marker.date] = (marker.beforeLabel, marker.afterLabel)
            case .before: labels[marker.date] = (marker.beforeLabel, nil)
            case .after: labels[marker.date] = (nil, marker.afterLabel)
            case .hidden: break
            }
        }
        return labels
    }

    private func switchText(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .fixedSize()
            .padding(.top, 2)
    }

    private func clock(_ date: Date) -> String {
        DashboardPresentation.date(date, timeZoneIdentifier: timeZone, dateStyle: .none, timeStyle: .short)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(lane.title)
                    .font(.subheadline.weight(.semibold))
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
            EnergyBalanceBackdrop(x: x, y: y)

            ForEach(Array(lane.switches.enumerated()), id: \.offset) { _, marker in
                RuleMark(x: .value("Switch", marker.date))
                    .foregroundStyle(EnergyWeatherChart.ruleColor)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    // "← Off-Peak" ends at the line and "On-Peak →" starts at it.
                    .annotation(position: .overlay, alignment: .topTrailing, spacing: 0,
                                overflowResolution: .init(x: .disabled, y: .fit(to: .chart))) {
                        if let before = labels[marker.date]?.before {
                            switchText(before).padding(.trailing, SwitchLabelLayout.inset)
                        }
                    }
                    .annotation(position: .overlay, alignment: .topLeading, spacing: 0,
                                overflowResolution: .init(x: .disabled, y: .fit(to: .chart))) {
                        if let after = labels[marker.date]?.after {
                            switchText(after).padding(.leading, SwitchLabelLayout.inset)
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
