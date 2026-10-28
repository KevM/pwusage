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
        return LiveScoreboard(
            battery: stateOfCharge.map { scoreboardBattery(cards: cards, charge: $0) },
            home: scoreboardStat(cards: cards, source: .home, symbol: "house.fill"),
            solar: scoreboardStat(cards: cards, source: .solar, symbol: "sun.max.fill"),
            grid: scoreboardGrid(cards: cards)
        )
    }

    private static func scoreboardCard(cards: [PowerCard], source: PowerSource) -> PowerCard? {
        cards.first { $0.id == source }
    }

    private static func scoreboardStat(cards: [PowerCard], source: PowerSource, symbol: String) -> ScoreboardStat {
        let reading = scoreboardCard(cards: cards, source: source).flatMap { $0.role == .unknown ? nil : $0.watts }
        let value = reading.map(power) ?? "--"
        return ScoreboardStat(symbol: symbol, value: value, spokenLabel: "\(source.title) \(value)")
    }

    private static func scoreboardBattery(cards: [PowerCard], charge: Double) -> BatteryScoreboardStat {
        let percent = "\(Int(charge.rounded()))%"
        let batteryCard = scoreboardCard(cards: cards, source: .battery)
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

    private static func scoreboardGrid(cards: [PowerCard]) -> ScoreboardStat? {
        let gridCard = scoreboardCard(cards: cards, source: .grid)
        guard gridCard?.role == .supplying || gridCard?.role == .receiving,
              let watts = gridCard?.watts else { return nil }
        let value = power(watts)
        return ScoreboardStat(
            symbol: gridCard?.role == .supplying ? "arrow.down.to.line" : "arrow.up.to.line",
            value: value,
            spokenLabel: "\(gridCard?.detail ?? "Grid") \(value)"
        )
    }
}
