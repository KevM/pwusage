import SwiftUI

enum TodayEnergyPresentation {
    static func energy(_ kWh: Double) -> String { String(format: "%.1f kWh", kWh) }
    static func signedEnergy(_ kWh: Double) -> String {
        let direction = kWh > 0 ? "↓ " : (kWh < 0 ? "↑ " : "")
        return direction + energy(abs(kWh))
    }

    static func tile(for metric: TodayEnergyMetric, snapshot: TodayEnergySnapshot?, at date: Date) -> MetricTile? {
        guard let snapshot, snapshot.availability(at: date) != .missing else { return nil }
        return tiles(homeKwh: snapshot.energy.homeKwh, solarKwh: snapshot.energy.solarKwh,
                     gridNetKwh: snapshot.energy.gridNetKwh, batteryNetKwh: snapshot.energy.batteryNetKwh,
                     compact: true, showsStateOfCharge: true, stateOfCharge: snapshot.stateOfCharge(at: date))[metric.index]
    }

    /// Same charge bands as the app's battery glyph. Unknown has no filled segments.
    static func batterySymbol(_ charge: Double?) -> String {
        guard let charge else { return "battery.0percent" }
        switch Int(charge.rounded()) {
        case ..<13: return "battery.0percent"
        case 13..<38: return "battery.25percent"
        case 38..<63: return "battery.50percent"
        case 63..<88: return "battery.75percent"
        default: return "battery.100percent"
        }
    }

    static func tiles(homeKwh: Double, solarKwh: Double, gridNetKwh: Double, batteryNetKwh: Double,
                      compact: Bool = false, showsStateOfCharge: Bool = false, stateOfCharge: Double? = nil) -> [MetricTile] {
        let chargeDescription = showsStateOfCharge
            ? stateOfCharge.map { "Battery charge \(Int($0.rounded())) percent" } ?? "Battery charge unknown"
            : nil
        return [
            MetricTile(title: "Home", value: energy(homeKwh), symbol: "house.fill", tint: .blue, compact: compact),
            MetricTile(title: "Solar", value: energy(solarKwh), symbol: "sun.max.fill", tint: .orange, compact: compact),
            MetricTile(title: "Grid", value: signedEnergy(gridNetKwh),
                       detail: gridNetKwh > 0 ? "Net import" : (gridNetKwh < 0 ? "Net export" : "Balanced"),
                       symbol: "powerplug", tint: .gray, compact: compact),
            MetricTile(title: "Battery", value: signedEnergy(batteryNetKwh),
                       detail: batteryNetKwh > 0 ? "Net discharge" : (batteryNetKwh < 0 ? "Net charge" : "Balanced"),
                       symbol: showsStateOfCharge ? batterySymbol(stateOfCharge) : "battery.100percent",
                       tint: .green, compact: compact,
                       symbolPrefix: showsStateOfCharge ? stateOfCharge.map { "\(Int($0.rounded()))%" } : nil,
                       spokenRole: chargeDescription)
        ]
    }
}

/// Widget layout over the same tiles the dashboard uses; kept renderable without WidgetKit storage.
struct TodayEnergyWidgetContent: View {
    let snapshot: TodayEnergySnapshot?
    let date: Date
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(compact ? "Today" : "Today so far").font((compact ? Font.footnote : .title3).weight(.bold))
                    .lineLimit(1).layoutPriority(1)
                    .accessibilityAddTraits(.isHeader)
                if compact, let snapshot, snapshot.availability(at: date) != .missing {
                    compactUpdate(snapshot)
                        .font(.caption2).lineLimit(1).minimumScaleFactor(0.8).layoutPriority(1)
                    if !snapshot.energy.todayComplete {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.caption2).foregroundStyle(.orange)
                            .accessibilityLabel("Some energy intervals are missing")
                    }
                }
                Spacer(minLength: 0)
                if let snapshot {
                    Text(snapshot.siteName).font(.caption2).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            if let snapshot, snapshot.availability(at: date) != .missing {
                let tiles = TodayEnergyPresentation.tiles(
                    homeKwh: snapshot.energy.homeKwh, solarKwh: snapshot.energy.solarKwh,
                    gridNetKwh: snapshot.energy.gridNetKwh, batteryNetKwh: snapshot.energy.batteryNetKwh,
                    compact: compact, showsStateOfCharge: true, stateOfCharge: snapshot.stateOfCharge(at: date)
                )
                if compact {
                    VStack(spacing: 6) {
                        HStack(spacing: 6) { tiles[0]; tiles[1] }
                            .frame(maxHeight: .infinity)
                        HStack(spacing: 6) { tiles[2]; tiles[3] }
                            .frame(maxHeight: .infinity)
                    }
                    .frame(maxHeight: .infinity)
                } else {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                        ForEach(tiles.indices, id: \.self) { tiles[$0] }
                    }
                    Spacer(minLength: 0)
                    HStack(spacing: 4) {
                        if let source = snapshot.energy.energyDataThrough {
                            let stale = snapshot.availability(at: date) == .stale
                            Label("\(stale ? "Stale" : "Updated") · \(updatedTime(source, timezone: snapshot.timezone))",
                                  systemImage: stale ? "clock.badge.exclamationmark" : "clock")
                                .foregroundStyle(stale ? .orange : .secondary)
                                .lineLimit(1).minimumScaleFactor(0.8)
                        }
                        if !snapshot.energy.todayComplete {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(.orange).accessibilityLabel("Some energy intervals are missing")
                        }
                    }.font(.caption2)
                    if !snapshot.energy.todayComplete {
                        Text("Some energy intervals are missing").font(.caption).foregroundStyle(.secondary)
                    }
                    Label(snapshot.energy.activeTariff.map { "Active tariff · \($0)" } ?? "No active tariff is configured",
                          systemImage: snapshot.energy.activeTariff == nil ? "info.circle" : "tag")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            } else {
                Spacer(minLength: 0)
                Label("No energy data yet", systemImage: "chart.bar").font(.subheadline.weight(.semibold))
                Text("Open pwusage to refresh your selected site.").font(.caption).foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        }
        // The medium widget has fixed height; bound text growth while preserving VoiceOver details.
        .dynamicTypeSize(.xSmall...(compact ? .xLarge : .accessibility5))
    }

    @ViewBuilder
    private func compactUpdate(_ snapshot: TodayEnergySnapshot) -> some View {
        if let source = snapshot.energy.energyDataThrough {
            let stale = snapshot.availability(at: date) == .stale
            let time = updatedTime(source, timezone: snapshot.timezone, includesTimezone: false)
            Label(stale ? "Stale · \(time)" : time,
                  systemImage: stale ? "clock.badge.exclamationmark" : "clock")
                .foregroundStyle(stale ? .orange : .secondary)
                .accessibilityLabel("\(stale ? "Stale. " : "")Updated \(updatedTime(source, timezone: snapshot.timezone))")
        }
    }

    private func updatedTime(_ date: Date, timezone: String, includesTimezone: Bool = true) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: timezone)
        formatter.dateFormat = includesTimezone ? "h:mm a z" : "h:mm a"
        return formatter.string(from: date)
    }
}
