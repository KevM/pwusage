import SwiftUI
import WidgetKit

struct TodayEnergyEntry: TimelineEntry {
    let date: Date
    let snapshot: TodayEnergySnapshot?
}

struct TodayEnergyProvider: TimelineProvider {
    func placeholder(in context: Context) -> TodayEnergyEntry { sample() }
    func getSnapshot(in context: Context, completion: @escaping (TodayEnergyEntry) -> Void) {
        completion(context.isPreview ? sample() : TodayEnergyEntry(date: .now, snapshot: TodayEnergySnapshotStore.shared()?.load()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<TodayEnergyEntry>) -> Void) {
        let now = Date()
        let snapshot = TodayEnergySnapshotStore.shared()?.load()
        var dates = [now]
        if let source = snapshot?.energy.energyDataThrough {
            let expiry = source.addingTimeInterval(TodayEnergySnapshot.staleAfter + 1)
            if expiry > now { dates.append(expiry) }
        }
        if let source = snapshot?.batteryStateOfChargeAt {
            let expiry = source.addingTimeInterval(2 * 3600 + 1)
            if expiry > now { dates.append(expiry) }
        }
        if let midnight = snapshot?.nextMidnight, midnight > now { dates.append(midnight) }
        completion(Timeline(entries: dates.sorted().map { TodayEnergyEntry(date: $0, snapshot: snapshot) },
                            policy: .after(now.addingTimeInterval(30 * 60))))
    }
    private func sample() -> TodayEnergyEntry {
        let now = Date()
        return TodayEnergyEntry(date: now, snapshot: TodayEnergySnapshot(siteID: "preview", siteName: "Home", timezone: "UTC", fetchedAt: now,
            energy: TodayEnergy(localDate: TodayEnergySnapshot.localDate(now, timezone: "UTC"), homeKwh: 18.4,
                                solarKwh: 22.6, gridNetKwh: -4.2, batteryNetKwh: -1.8,
                                activeTariff: "Off peak", energyDataThrough: now),
            batteryStateOfCharge: 78, batteryStateOfChargeAt: now))
    }
}

struct TodayEnergyWidgetView: View {
    let entry: TodayEnergyEntry
    @Environment(\.widgetFamily) private var family
    var body: some View {
        TodayEnergyWidgetContent(snapshot: entry.snapshot, date: entry.date, compact: family == .systemMedium)
            .widgetURL(URL(string: "pwusage://dashboard"))
            .privacySensitive()
            .containerBackground(Color(uiColor: .secondarySystemGroupedBackground), for: .widget)
    }
}

@main
struct TodayEnergyWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: TodayEnergySnapshot.widgetKind, provider: TodayEnergyProvider()) { entry in
            TodayEnergyWidgetView(entry: entry)
        }
        .configurationDisplayName("Today's Energy")
        .description("Home, solar, net grid and battery energy today, with the battery charge glyph.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}
