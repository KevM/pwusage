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
                        .font(.system(size: 9)).foregroundStyle(.white.opacity(stale ? 1 : secondaryOpacity))
                        .lineLimit(1).minimumScaleFactor(0.8)
                        .accessibilityLabel(
                            "\(stale ? "Stale. " : "")Updated \(time(source, timezone: snapshot.timezone))"
                        )
                }
            }
            if let tile = selectedTile {
                tile
            } else {
                let identity = TodayEnergyPresentation.tiles(homeKwh: 0, solarKwh: 0, gridNetKwh: 0, batteryNetKwh: 0,
                                                             compact: true, showsStateOfCharge: true)[metric.index]
                MetricTile(title: identity.title, value: "—", symbol: identity.symbol, tint: identity.tint,
                           compact: true, prominentValue: true,
                           spokenRole: "Energy unavailable. Open pwusage to refresh.", surface: .onFill)
            }
            if snapshot == nil || snapshot?.availability(at: date) == .missing {
                Text("Open pwusage").font(.caption2).foregroundStyle(.white.opacity(secondaryOpacity))
            } else if let snapshot {
                HStack(spacing: 4) {
                    Text(snapshot.siteName).lineLimit(1).truncationMode(.tail)
                    if !snapshot.energy.todayComplete {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .accessibilityLabel("Some energy intervals are missing")
                    }
                }.font(.caption2).foregroundStyle(.white.opacity(secondaryOpacity))
            }
        }
        .foregroundStyle(.white)
        .dynamicTypeSize(.xSmall ... .xLarge)
    }

    /// Secondary text on the metric fill: white, slightly receded, still readable on the deep end.
    private let secondaryOpacity = 0.8

    private var selectedTile: MetricTile? {
        guard var tile = TodayEnergyPresentation.tile(for: metric, snapshot: snapshot, at: date) else { return nil }
        tile.prominentValue = true
        tile.surface = .onFill
        return tile
    }

    private func time(_ date: Date, timezone: String) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: timezone)
        formatter.dateFormat = "h:mm a"
        return formatter.string(from: date)
    }
}
