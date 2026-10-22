import Charts
import SwiftUI

/// Shared zero line and export-cushion/import-gap bands for Billing and Smart Shift.
struct EnergyBalanceBackdrop: ChartContent {
    let x: ClosedRange<Date>
    let y: ClosedRange<Double>
    var body: some ChartContent {
        RectangleMark(xStart: .value("Start", x.lowerBound), xEnd: .value("End", x.upperBound),
                      yStart: .value("Zero", 0), yEnd: .value("Top", y.upperBound))
            .foregroundStyle(EnergyWeatherChart.bankedColor.opacity(0.12))
        RectangleMark(xStart: .value("Start", x.lowerBound), xEnd: .value("End", x.upperBound),
                      yStart: .value("Bottom", y.lowerBound), yEnd: .value("Zero", 0))
            .foregroundStyle(EnergyWeatherChart.owedColor.opacity(0.14))
        RuleMark(y: .value("Zero", 0))
            .foregroundStyle(EnergyWeatherChart.ruleColor)
            .lineStyle(StrokeStyle(lineWidth: 1))
    }
}

struct BillOutlookChart: View {
    let history: BillOutlookHistory
    let projected: [BillOutlookPoint]
    let cycleStart: Date
    let cycleEnd: Date
    let now: Date
    let timeZone: String
    let currency: String
    @State private var selectedDate: Date?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var points: [BillOutlookPoint] {
        history.points.filter(\.complete) + projected.dropFirst()
    }
    private var selection: BillOutlookPoint? {
        BillOutlookPresentation.selection(in: points, date: selectedDate)
    }
    private var periods: [BillOutlookPeriod] {
        var values: [String: BillOutlookPeriod] = [:]
        for point in history.points + projected { for period in point.periods { values[period.key] = period } }
        return values.values.sorted { $0.key < $1.key }
    }
    private func energy(_ point: BillOutlookPoint, key: String) -> Double {
        -(point.periods.first { $0.key == key }?.netGridKwh ?? 0)
    }
    private func date(_ value: Date) -> String {
        DashboardPresentation.date(value, timeZoneIdentifier: timeZone, dateStyle: .short)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Bill outlook").font(.headline)
            HStack(spacing: 16) {
                legend("Recorded", dashed: false)
                if !projected.isEmpty { legend("Estimated", dashed: true) }
            }
            Text("Green: export cushion · Orange: import gap")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(periods, id: \.key) { period in
                lane(period)
            }
            if let selection {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(date(selection.date)).font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(DashboardPresentation.currency(selection.estimatedCost, code: currency))
                            .font(.subheadline.weight(.semibold)).monospacedDigit()
                    }
                    Text(selection.date > history.observedThrough ? "Estimated from expected energy use" : "Estimated from recorded energy")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Previous day", systemImage: "chevron.left") { step(-1) }
                            .disabled(points.first?.date == selection.date)
                        Spacer()
                        Button("Next day", systemImage: "chevron.right") { step(1) }
                            .disabled(points.last?.date == selection.date)
                    }.font(.caption).labelStyle(.iconOnly)
                }
            }
            Text("Cycle ends \(date(cycleEnd)). Tap or drag to explore the daily estimates.")
                .font(.caption).foregroundStyle(.secondary)
            if !history.complete {
                Text("Some recorded energy is missing. A full-cycle forecast is unavailable.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(17)
        .background(SectionTheme.secondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 20))
    }
    private func legend(_ label: String, dashed: Bool) -> some View {
        HStack(spacing: 5) {
            Path { path in path.move(to: .init(x: 0, y: 4)); path.addLine(to: .init(x: 20, y: 4)) }
                .stroke(.indigo, style: StrokeStyle(lineWidth: 2, dash: dashed ? [4, 3] : []))
                .frame(width: 20, height: 8)
            Text(label).font(.caption)
        }
    }
    private func step(_ direction: Int) {
        guard let selection, let index = points.firstIndex(where: { $0.date == selection.date }), !points.isEmpty else { return }
        selectedDate = points[min(max(index + direction, 0), points.count - 1)].date
    }
    private func laneTitle(_ period: BillOutlookPeriod) -> some View {
        Text(DashboardPresentation.tariffPeriodTitle(period.periodName)).font(.caption.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
    }
    @ViewBuilder private func laneBalance(_ period: BillOutlookPeriod) -> some View {
        if let selection {
            Text(BillOutlookPresentation.balance(-energy(selection, key: period.key))).font(.caption)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
    private func lane(_ period: BillOutlookPeriod) -> some View {
        let recorded = history.points.filter(\.complete)
        let all = recorded + projected
        let values = all.map { energy($0, key: period.key) } + [0]
        let low = values.min() ?? 0, high = values.max() ?? 0
        let pad = max(2, (high - low) * 0.25)
        let y = (low - pad)...(high + pad)
        let x = cycleStart...max(cycleEnd, cycleStart.addingTimeInterval(3600))
        return VStack(alignment: .leading, spacing: 5) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 3) { laneTitle(period); laneBalance(period) }
            } else {
                HStack { laneTitle(period); Spacer(); laneBalance(period) }
            }
            if Set(periods.map(\.tariffName)).count > 1 {
                Text(period.tariffName).font(.caption2).foregroundStyle(.secondary)
            }
            Chart {
                EnergyBalanceBackdrop(x: x, y: y)
                ForEach(Array(recorded.enumerated()), id: \.offset) { _, point in
                    LineMark(x: .value("Date", point.date), y: .value("kWh", energy(point, key: period.key)),
                             series: .value("Source", "Recorded"))
                        .foregroundStyle(.indigo).lineStyle(EnergyWeatherChart.laterStroke)
                }
                ForEach(Array(projected.enumerated()), id: \.offset) { _, point in
                    LineMark(x: .value("Date", point.date), y: .value("kWh", energy(point, key: period.key)),
                             series: .value("Source", "Estimated"))
                        .foregroundStyle(.indigo).lineStyle(StrokeStyle(lineWidth: 2, dash: [4, 3]))
                }
                if now >= cycleStart && now < cycleEnd {
                    RuleMark(x: .value("Now", now)).foregroundStyle(.secondary)
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [2, 3]))
                        .annotation(position: .overlay, alignment: .topLeading, spacing: 0,
                                    overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                            Text("Now").font(.caption2).foregroundStyle(.secondary).fixedSize().padding(3)
                                .background(.background.opacity(0.8))
                        }
                }
                RuleMark(x: .value("Cycle end", cycleEnd)).foregroundStyle(.secondary)
                if let selectedDate, let selection {
                    RuleMark(x: .value("Selected", selectedDate)).foregroundStyle(.indigo.opacity(0.5))
                    PointMark(x: .value("Date", selection.date), y: .value("kWh", energy(selection, key: period.key)))
                        .foregroundStyle(.indigo)
                }
            }
            .chartXScale(domain: x).chartYScale(domain: y)
            .chartYAxis(.hidden)
            .chartXAxis(.hidden)
            .chartLegend(.hidden)
            .chartXSelection(value: $selectedDate)
            .frame(height: 125)
            .accessibilityLabel("\(period.periodName) export cushion and import gap in kilowatt-hours")
            HStack {
                Text(date(cycleStart))
                Spacer()
                Text(date(cycleEnd))
            }.font(.caption2).foregroundStyle(.secondary)
        }
    }
}
