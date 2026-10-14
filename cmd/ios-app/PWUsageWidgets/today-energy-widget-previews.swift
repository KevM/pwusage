#if DEBUG
import SwiftUI
import WidgetKit

/// Fixed, local fixtures: previews never read the App Group or contact the server.
private enum TodayEnergyWidgetPreview {
    static let date = Date(timeIntervalSince1970: 1_792_008_000)
    static let timezone = "America/Chicago"

    static func entry(
        cost: Double? = 2.18,
        homeKwh: Double = 18.4,
        importKwh: Double = 8.6,
        exportKwh: Double = 2.1,
        sourceAge: TimeInterval = 5 * 60,
        siteName: String = "Home",
        displayDate: Date = date
    ) -> TodayEnergyEntry {
        let source = date.addingTimeInterval(-sourceAge)
        return TodayEnergyEntry(date: displayDate, snapshot: TodayEnergySnapshot(
            siteID: "preview-home", siteName: siteName, timezone: timezone, fetchedAt: date,
            energy: TodayEnergy(
                localDate: TodayEnergySnapshot.localDate(date, timezone: timezone),
                homeKwh: homeKwh, importKwh: importKwh, exportKwh: exportKwh,
                estimatedCost: cost, currency: "USD", energyDataThrough: source
            )
        ))
    }
}

#Preview("Current · Medium", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    TodayEnergyWidgetPreview.entry()
}

#Preview("Current · Large", as: .systemLarge) { TodayEnergyWidget() } timeline: {
    TodayEnergyWidgetPreview.entry()
}

#Preview("Export credit · Medium", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    TodayEnergyWidgetPreview.entry(cost: -0.42, importKwh: 5.2, exportKwh: 8.1)
}

#Preview("Stale · Medium", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    TodayEnergyWidgetPreview.entry(sourceAge: 2 * 60 * 60)
}

#Preview("Stale · Large", as: .systemLarge) { TodayEnergyWidget() } timeline: {
    TodayEnergyWidgetPreview.entry(sourceAge: 2 * 60 * 60)
}

#Preview("Cost unavailable · Medium", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    TodayEnergyWidgetPreview.entry(cost: nil)
}

#Preview("No energy yet · Medium", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    TodayEnergyEntry(date: TodayEnergyWidgetPreview.date, snapshot: nil)
}

#Preview("No energy yet · Large", as: .systemLarge) { TodayEnergyWidget() } timeline: {
    TodayEnergyEntry(date: TodayEnergyWidgetPreview.date, snapshot: nil)
}

#Preview("Long name and totals · Medium", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    TodayEnergyWidgetPreview.entry(cost: 128.45, homeKwh: 1234.5, importKwh: 987.6, exportKwh: 456.7,
                                   siteName: "Our family's home with a long site name")
}

#Preview("Fresh → stale → next day", as: .systemMedium) { TodayEnergyWidget() } timeline: {
    TodayEnergyWidgetPreview.entry()
    TodayEnergyWidgetPreview.entry(displayDate: TodayEnergyWidgetPreview.date.addingTimeInterval(2 * 60 * 60))
    TodayEnergyWidgetPreview.entry(displayDate: TodayEnergyWidgetPreview.date.addingTimeInterval(24 * 60 * 60))
}
#endif
