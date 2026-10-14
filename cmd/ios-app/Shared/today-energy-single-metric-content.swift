import SwiftUI

struct TodayEnergySingleMetricContent: View {
    let snapshot: TodayEnergySnapshot?
    let date: Date
    let metric: TodayEnergyMetric

    var body: some View {
        VStack(spacing: 5) {
            HStack(spacing: 4) {
                Text("Today").font(.footnote.weight(.bold)).lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                if let snapshot, snapshot.availability(at: date) != .missing,
                   let source = snapshot.energy.energyDataThrough {
                    let stale = snapshot.availability(at: date) == .stale
                    Label(stale ? "Stale" : time(source, timezone: snapshot.timezone),
                          systemImage: stale ? "clock.badge.exclamationmark" : "clock")
                        .font(.system(size: 9)).foregroundStyle(stale ? .orange : .secondary)
                        .lineLimit(1).minimumScaleFactor(0.8)
                        .accessibilityLabel("\(stale ? "Stale. " : "")Updated \(time(source, timezone: snapshot.timezone))")
                }
            }
            if let tile = selectedTile {
                tile
            } else {
                let identity = TodayEnergyPresentation.tiles(homeKwh: 0, solarKwh: 0, gridNetKwh: 0, batteryNetKwh: 0,
                                                             compact: true, showsStateOfCharge: true)[metric.index]
                MetricTile(title: identity.title, value: "—", symbol: identity.symbol, tint: identity.tint,
                           compact: true, prominentValue: true, spokenRole: "Energy unavailable. Open pwusage to refresh.")
            }
            if snapshot == nil || snapshot?.availability(at: date) == .missing {
                Text("Open pwusage").font(.caption2).foregroundStyle(.secondary)
            } else if let snapshot {
                HStack(spacing: 4) {
                    Text(snapshot.siteName).lineLimit(1).truncationMode(.tail)
                    if !snapshot.energy.todayComplete {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                            .accessibilityLabel("Some energy intervals are missing")
                    }
                }.font(.caption2).foregroundStyle(.secondary)
            }
        }
        .dynamicTypeSize(.xSmall ... .xLarge)
    }

    private var selectedTile: MetricTile? {
        guard var tile = TodayEnergyPresentation.tile(for: metric, snapshot: snapshot, at: date) else { return nil }
        tile.prominentValue = true
        return tile
    }

    private func time(_ date: Date, timezone: String) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: timezone)
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    }
}
