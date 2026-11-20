import SwiftUI

/// A plan's name, an optional source line, and each season's time windows with their buy and sell rates.
struct TeslaSyncPlanRows: View {
    let name: String
    let seasons: [TariffSeasonInput]
    let currency: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(name).font(.headline)
            if let detail {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(seasons.enumerated()), id: \.offset) { _, season in
                TeslaSyncSeasonRows(season: season, currency: currency)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }
}

private struct TeslaSyncSeasonRows: View {
    let season: TariffSeasonInput
    let currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            let months = RatePlanTimelineFormatting.seasonMonthLabel(
                fromMonth: season.fromMonth, toMonth: season.toMonth
            )
            Text("\(season.name) · \(months)")
                .font(.subheadline.weight(.semibold))
            windowLines("Weekdays", windows: season.weekdayPeriods)
            windowLines("Weekends", windows: season.weekendPeriods)
        }
    }

    @ViewBuilder
    private func windowLines(_ day: String, windows: [TimePeriodWindowInput]) -> some View {
        if !windows.isEmpty {
            Text(day)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(Array(windows.enumerated()), id: \.offset) { _, window in
                Text(windowText(window))
                    .font(.caption.monospacedDigit())
            }
        }
    }

    private func windowText(_ window: TimePeriodWindowInput) -> String {
        let time = RatePlanTimelineFormatting.windowTimeLabel(window)
        let buy = RateFormatting.formatRate(window.buyRate, currency: currency)
        let sell = RateFormatting.formatRate(window.sellRate, currency: currency)
        return "\(window.touName.displayName) \(time) · Buy \(buy) · Sell \(sell)"
    }
}
