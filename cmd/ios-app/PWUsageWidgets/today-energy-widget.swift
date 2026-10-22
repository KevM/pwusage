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
    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<TodayEnergyEntry>) -> Void) {
        Task {
            let snapshot = await TodayEnergyWidgetRefresh.current()
            let now = Date()
            let dates = TodayEnergySnapshot.timelineDates(for: snapshot, at: now)
            completion(Timeline(entries: dates.map { TodayEnergyEntry(date: $0, snapshot: snapshot) },
                                policy: .after(now.addingTimeInterval(30 * 60))))
        }
    }
    private func sample() -> TodayEnergyEntry {
        let now = Date()
        return TodayEnergyEntry(date: now, snapshot: .sample(at: now))
    }
}

struct TodayEnergyWidgetView: View {
    let entry: TodayEnergyEntry
    @Environment(\.widgetFamily) private var family
    var body: some View {
        TodayEnergyWidgetFamilyContent(snapshot: entry.snapshot, date: entry.date, family: family)
            .widgetURL(TodayEnergySnapshot.dashboardURL)
            .privacySensitive()
            .containerBackground(Color(uiColor: .secondarySystemGroupedBackground), for: .widget)
    }
}

struct TodayEnergyWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: TodayEnergySnapshot.widgetKind, provider: TodayEnergyProvider()) { entry in
            TodayEnergyWidgetView(entry: entry)
        }
        .configurationDisplayName("Today's Energy")
        .description("Home, solar, net grid and battery energy today, with the battery charge glyph.")
        .supportedFamilies([.systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}

@main
struct TodayEnergyWidgetBundle: WidgetBundle {
    var body: some Widget {
        TodayEnergyWidget()
        TodayEnergyMetricWidget()
        BatteryHoldControl()
        BatteryHoldLiveActivity()
    }
}
