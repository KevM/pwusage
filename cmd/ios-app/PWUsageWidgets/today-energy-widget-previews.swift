#if DEBUG
import SwiftUI
import WidgetKit

private func entry(_ snapshot: TodayEnergySnapshot? = TodayEnergyPreviewFixtures.snapshot(),
                   at date: Date = TodayEnergyPreviewFixtures.date) -> TodayEnergyEntry {
    TodayEnergyEntry(date: date, snapshot: snapshot)
}

#Preview("Today so far · Medium", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    entry()
}

#Preview("Today so far · Large", as: .systemLarge) { TodayEnergyWidget() } timeline: {
    entry()
}

#Preview("Importing and discharging", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    entry(TodayEnergyPreviewFixtures.snapshot(solarKwh: 4, gridNetKwh: 12, batteryNetKwh: 2.4, stateOfCharge: 20))
}

#Preview("Full battery · Large", as: .systemLarge) { TodayEnergyWidget() } timeline: {
    entry(TodayEnergyPreviewFixtures.snapshot(stateOfCharge: 100))
}

#Preview("Unknown battery charge", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    entry(TodayEnergyPreviewFixtures.snapshot(stateOfCharge: nil))
}

#Preview("Stale battery charge, current energy", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    entry(TodayEnergyPreviewFixtures.snapshot(chargeAge: 2 * 3600 + 1))
}

#Preview("Stale energy · Medium", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    entry(TodayEnergyPreviewFixtures.snapshot(sourceAge: 2 * 3600))
}

#Preview("Stale energy · Large", as: .systemLarge) { TodayEnergyWidget() } timeline: {
    entry(TodayEnergyPreviewFixtures.snapshot(sourceAge: 2 * 3600))
}

#Preview("Missing intervals · Large", as: .systemLarge) { TodayEnergyWidget() } timeline: {
    entry(TodayEnergyPreviewFixtures.snapshot(complete: false))
}

#Preview("No energy yet · Medium", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    entry(nil)
}

#Preview("No energy yet · Large", as: .systemLarge) { TodayEnergyWidget() } timeline: {
    entry(nil)
}

#Preview("Long name and large totals", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    entry(TodayEnergyPreviewFixtures.snapshot(homeKwh: 1234.5, solarKwh: 456.7, gridNetKwh: 987.6,
                                            batteryNetKwh: -209.8, siteName: "Our family's home with a long site name"))
}

#Preview("Fresh → stale → next day", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    entry()
    entry(at: TodayEnergyPreviewFixtures.date.addingTimeInterval(2 * 3600))
    entry(at: TodayEnergyPreviewFixtures.date.addingTimeInterval(24 * 3600))
}
#Preview("Small device · Medium") {
    TodayEnergyWidgetContent(snapshot: TodayEnergyPreviewFixtures.snapshot(), date: TodayEnergyPreviewFixtures.date, compact: true)
        .padding(10).frame(width: 292, height: 141)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 22))
}

#Preview("Small · Home", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
    TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date, snapshot: TodayEnergyPreviewFixtures.snapshot(), metric: .home)
}

#Preview("Small · Solar", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
    TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date, snapshot: TodayEnergyPreviewFixtures.snapshot(), metric: .solar)
}

#Preview("Small · Grid", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
    TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date, snapshot: TodayEnergyPreviewFixtures.snapshot(), metric: .grid)
}

#Preview("Small · Battery", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
    TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date, snapshot: TodayEnergyPreviewFixtures.snapshot(), metric: .battery)
}

#Preview("Small · Stale grid", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
    TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date,
                          snapshot: TodayEnergyPreviewFixtures.snapshot(sourceAge: 2 * 3600), metric: .grid)
}

#Preview("Small · Unknown SOC", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
    TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date,
                          snapshot: TodayEnergyPreviewFixtures.snapshot(stateOfCharge: nil), metric: .battery)
}

#Preview("Small · No data", as: .systemSmall) { TodayEnergyMetricWidget() } timeline: {
    TodayEnergyMetricEntry(date: TodayEnergyPreviewFixtures.date, snapshot: nil, metric: .solar)
}
#endif
