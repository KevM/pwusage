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
        if let midnight = snapshot?.nextMidnight, midnight > now { dates.append(midnight) }
        completion(Timeline(entries: dates.sorted().map { TodayEnergyEntry(date: $0, snapshot: snapshot) },
                            policy: .after(now.addingTimeInterval(30 * 60))))
    }
    private func sample() -> TodayEnergyEntry {
        let now = Date()
        return TodayEnergyEntry(date: now, snapshot: TodayEnergySnapshot(siteID: "preview", siteName: "Home", timezone: "UTC", fetchedAt: now,
            energy: TodayEnergy(localDate: TodayEnergySnapshot.localDate(now, timezone: "UTC"), homeKwh: 18.4,
                                importKwh: 5.2, exportKwh: 8.1, estimatedCost: -0.42, currency: "USD", energyDataThrough: now)))
    }
}

struct TodayEnergyWidgetView: View {
    let entry: TodayEnergyEntry
    @Environment(\.widgetFamily) private var family
    var body: some View {
        VStack(alignment: .leading, spacing: family == .systemLarge ? 18 : 6) {
            Label("Today's Energy", systemImage: "bolt.fill").font(.headline)
            if let snapshot = entry.snapshot, snapshot.availability(at: entry.date) != .missing {
                Text(snapshot.siteName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: family == .systemLarge ? 24 : 8) {
                    GridRow {
                        metric("Consumption", energy(snapshot.energy.homeKwh))
                        metric("Est. net cost", cost(snapshot.energy))
                    }
                    GridRow {
                        metric("Grid import", energy(snapshot.energy.importKwh))
                        metric("Grid export", energy(snapshot.energy.exportKwh))
                    }
                }
                Spacer(minLength: 0)
                if snapshot.availability(at: entry.date) == .stale {
                    Text("Stale · Open pwusage to update").font(.caption2).foregroundStyle(.orange)
                }
                if let source = snapshot.energy.energyDataThrough {
                    Text("Updated \(updatedTime(source, timezone: snapshot.timezone))")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                Spacer(minLength: 0)
                Text("Today's data unavailable").font(.subheadline.bold())
                Text("Open pwusage to sign in and refresh your selected site.").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
        .widgetURL(URL(string: "pwusage://dashboard"))
        .privacySensitive()
        .containerBackground(.background, for: .widget)
    }
    private func metric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.system(.title3, design: .rounded).weight(.semibold)).minimumScaleFactor(0.7).lineLimit(1)
        }.accessibilityElement(children: .combine)
    }
    private func updatedTime(_ date: Date, timezone: String) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: timezone)
        formatter.dateFormat = "h:mm a z"
        return formatter.string(from: date)
    }
    private func energy(_ value: Double) -> String { "\(value.formatted(.number.precision(.fractionLength(1)))) kWh" }
    private func cost(_ value: TodayEnergy) -> String {
        value.estimatedCost.map { $0.formatted(.currency(code: value.currency)) } ?? "Unavailable"
    }
}

@main
struct TodayEnergyWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: TodayEnergySnapshot.widgetKind, provider: TodayEnergyProvider()) { entry in
            TodayEnergyWidgetView(entry: entry)
        }
        .configurationDisplayName("Today's Energy")
        .description("Consumption, grid import and export, and estimated net electricity cost for your selected site.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}
