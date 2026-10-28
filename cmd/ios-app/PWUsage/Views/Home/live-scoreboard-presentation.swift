import Foundation

/// The Home bar scoreboard shown once the Live card scrolls under the bar.
extension DashboardPresentation {
    /// Whether at least 15% of the Live card shows below the bar, all in scroll
    /// content coordinates. An unmeasured card counts as visible.
    static func liveCardIsVisible(cardMinY: Double, cardMaxY: Double, visibleTop: Double) -> Bool {
        let height = cardMaxY - cardMinY
        guard height > 0 else { return true }
        return cardMaxY - max(visibleTop, cardMinY) >= height * 0.15
    }

    struct ScoreboardStat: Equatable {
        let symbol: String
        let value: String
        let spokenLabel: String
    }

    struct BatteryScoreboardStat: Equatable {
        let symbol: String
        let charge: String
        /// Signed flow, "+" charging and "−" discharging; nil when idle.
        let flow: String?
        let spokenLabel: String
    }

    /// The Home bar's compact stats once the Live card scrolls away. Battery, home
    /// and solar always show; grid only while it imports or exports.
    struct LiveScoreboard: Equatable {
        let battery: BatteryScoreboardStat?
        let home: ScoreboardStat
        let solar: ScoreboardStat
        let grid: ScoreboardStat?

        func accessibilityLabel(siteName: String) -> String {
            let stats = [battery?.spokenLabel, home.spokenLabel, solar.spokenLabel, grid?.spokenLabel]
            return "\(siteName). " + stats.compactMap { $0 }.joined(separator: ", ")
        }
    }

    /// Built from the card's flow so the bar shares its stale and idle rules;
    /// a flow with no current reading gives no scoreboard.
    static func liveScoreboard(flow: PowerFlow, stateOfCharge: Double?) -> LiveScoreboard? {
        let cards = flow.supplying + flow.receiving
        guard !cards.allSatisfy({ $0.role == .unknown }) else { return nil }
        func card(_ source: PowerSource) -> PowerCard? { cards.first { $0.id == source } }
        func stat(_ source: PowerSource, symbol: String) -> ScoreboardStat {
            // A reading powerFlow could not trust (say, negative solar) shows as unknown.
            let reading = card(source).flatMap { $0.role == .unknown ? nil : $0.watts }
            let value = reading.map(power) ?? "--"
            return ScoreboardStat(symbol: symbol, value: value, spokenLabel: "\(source.title) \(value)")
        }

        let battery = stateOfCharge.map { charge -> BatteryScoreboardStat in
            let percent = "\(Int(charge.rounded()))%"
            let batteryCard = card(.battery)
            let watts = batteryCard?.watts ?? 0
            let signedWatts: Double
            switch batteryCard?.role {
            case .supplying: signedWatts = watts
            case .receiving: signedWatts = -watts
            default: signedWatts = 0
            }
            let flowValue = power(watts)
            let flow: String?
            let spoken: String
            switch batteryCard?.role {
            case .receiving:
                flow = "+\(flowValue)"
                spoken = "Battery \(percent), charging \(flowValue)"
            case .supplying:
                flow = "\u{2212}\(flowValue)"
                spoken = "Battery \(percent), discharging \(flowValue)"
            default:
                flow = nil
                spoken = "Battery \(percent)"
            }
            return BatteryScoreboardStat(
                symbol: batterySymbol(powerWatts: signedWatts, stateOfCharge: charge),
                charge: percent, flow: flow, spokenLabel: spoken
            )
        }

        let grid = card(.grid).flatMap { gridCard -> ScoreboardStat? in
            guard gridCard.role == .supplying || gridCard.role == .receiving, let watts = gridCard.watts else { return nil }
            let value = power(watts)
            return ScoreboardStat(
                symbol: gridCard.role == .supplying ? "arrow.down.to.line" : "arrow.up.to.line",
                value: value, spokenLabel: "\(gridCard.detail) \(value)"
            )
        }

        return LiveScoreboard(
            battery: battery,
            home: stat(.home, symbol: "house.fill"),
            solar: stat(.solar, symbol: "sun.max.fill"),
            grid: grid
        )
    }
}
