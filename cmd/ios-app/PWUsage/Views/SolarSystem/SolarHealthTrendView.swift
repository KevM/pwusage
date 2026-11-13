import Charts
import SwiftUI

/// Monthly fitted capacity and current-year daily clear-day ratios.
struct SolarHealthTrendView: View {
    let report: SolarHealthReport

    var body: some View {
        List {
            if !report.changeOverTime.years.isEmpty {
                yearlySection
            }
            if !report.changeOverTime.months.isEmpty {
                monthlyChartSection
            }
            if !report.dailyRatios.isEmpty {
                dailyChartSection
            }
        }
        .navigationTitle("Capacity & Ratio Trend")
        .inlineNavigationTitle()
    }

    private var yearlySection: some View {
        Section("By Year") {
            ForEach(report.changeOverTime.years) { entry in
                let percent = Int((entry.factor * 100).rounded())
                LabeledContent(
                    String(entry.year),
                    value: "\(percent)% · \(entry.clearDays) clear days")
            }
        }
    }

    private var monthlyChartSection: some View {
        Section("Monthly Capacity") {
            Chart(report.changeOverTime.months) { entry in
                PointMark(
                    x: .value("Month", monthDate(year: entry.year, month: entry.month)),
                    y: .value("Capacity", entry.factor * 100))
                    .foregroundStyle(Color.emphasis)
                LineMark(
                    x: .value("Month", monthDate(year: entry.year, month: entry.month)),
                    y: .value("Capacity", entry.factor * 100))
                    .foregroundStyle(Color.emphasis.opacity(0.6))
            }
            .chartYScale(domain: .automatic(includesZero: false))
            .chartYAxisLabel("%")
            .frame(height: 180)
            .padding(.vertical, 4)
        }
    }

    private var dailyChartSection: some View {
        Section("Current Year Clear-Day Ratio") {
            Chart(report.dailyRatios, id: \.day) { entry in
                PointMark(
                    x: .value("Day", entry.day),
                    y: .value("Ratio", entry.ratio * 100))
                    .foregroundStyle(Color.orange)
            }
            .chartXAxis(.hidden)
            .chartYScale(domain: .automatic(includesZero: false))
            .chartYAxisLabel("%")
            .frame(height: 180)
            .padding(.vertical, 4)
        }
    }

    private func monthDate(year: Int, month: Int) -> Date {
        Calendar(identifier: .gregorian).date(from: DateComponents(year: year, month: month, day: 15)) ?? .now
    }
}
