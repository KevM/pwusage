import Foundation
@testable import PWUsage
import Testing

struct SmartShiftPresentationTests {
    typealias Estimator = LoadTimingForecastEstimator

    /// Local midnight in UTC; `start` in the estimator tests is 08:00 on this day.
    static let day0 = Date(timeIntervalSince1970: 1_800_000_000 - 8 * 3600)
    static func at(_ hours: Double) -> Date { day0.addingTimeInterval(hours * 3600) }
    static let now = at(8.5)
    static let horizonEnd = at(48)

    static let car = LoadProfile(id: "car", name: "Charge the car", kind: .car, energyKwh: 0, durationHours: 0,
                                 carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20,
                                                              targetStateOfCharge: 80, chargingLevel: .level2))

    /// Peak 07:00–16:30, Off-Peak otherwise, over two days.
    static func timing(hasTariff: Bool = true) -> LoadTiming {
        let spans = [TariffSpan(0, 7, "Off-Peak"), TariffSpan(7, 16.5, "Peak"), TariffSpan(16.5, 31, "Off-Peak"),
                     TariffSpan(31, 40.5, "Peak"), TariffSpan(40.5, 48, "Off-Peak")]
        let segments = spans.map { span in
            LoadTimingTariffSegment(start: at(span.start), end: at(span.end), periodKey: span.key, name: span.key,
                                    buyRate: span.key == "Peak" ? 0.38 : 0.20,
                                    sellRate: span.key == "Peak" ? 0.10 : 0.26)
        }
        let periods = [("Peak", -6.0, 0.38, 0.10), ("Off-Peak", 18.0, 0.20, 0.26)].map { name, balance, buy, sell in
            LoadTimingPeriod(name: name, marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: balance,
                             isActive: name == "Peak", nextStartPhrase: nil, buyRate: buy, sellRate: sell)
        }
        return LoadTiming(hasTariff: hasTariff, hasCycleData: true, activeIsCheapest: false, periods: periods,
                          pricingPeriods: periods, tariffTimeline: segments, nextCheaper: nil, nextCheaperPhrase: nil,
                          nextStartPhraseByKey: [:])
    }

    static func lane(_ key: String, start: Double, later: Double, startNow: Double) -> Estimator.BalanceLane {
        Estimator.BalanceLane(periodKey: key, startKwh: start,
                              recommended: [.init(date: now, kwh: start), .init(date: horizonEnd, kwh: later)],
                              startNow: [.init(date: now, kwh: start), .init(date: horizonEnd, kwh: startNow)])
    }

    static let laterLanes = [lane("Peak", start: -6, later: -6, startNow: -20),
                             lane("Off-Peak", start: 18, later: 4, startNow: 18)]

    static func comparison(
        costNow: Double = 5.27,
        recommendedCost: Double = 3.38,
        savings: Double = 1.89,
        recommendedStart: Date = at(16.5),
        lanes: [Estimator.BalanceLane] = laterLanes,
        hasUnobservedBalance: Bool = false
    ) -> Estimator.Comparison {
        Estimator.Comparison(
            costNow: costNow, recommendedStart: recommendedStart,
            recommendedEnd: recommendedStart.addingTimeInterval(5.9 * 3600),
            recommendedCost: recommendedCost, savings: savings, bestAlternativeSavings: savings,
            estimatedSolarContribution: 0, horizonStart: now, horizonEnd: horizonEnd,
            evaluatedStarts: [now, recommendedStart], assumptions: ["Held still."],
            hasUnobservedBalance: hasUnobservedBalance, lanes: lanes, periodSwitches: [at(16.5), at(31), at(40.5)])
    }

    static func make(
        profile: LoadProfile? = car,
        result: Estimator.Result = Estimator.Result(comparison: comparison(), unavailableReason: nil),
        forecast: ForecastAvailability = .none,
        refreshUnavailable: Bool = false,
        timing: LoadTiming = timing(),
        billingCycleEnd: Date = at(24 * 20)
    ) -> SmartShiftScreen {
        SmartShiftPresentation.make(profile: profile, result: result, forecast: forecast,
                                    refreshUnavailable: refreshUnavailable, timing: timing, now: now,
                                    billingCycleEnd: billingCycleEnd, currencyCode: "USD", timeZone: "UTC")
    }

    static func verdict(_ screen: SmartShiftScreen) throws -> SmartShiftVerdict {
        guard case .verdict(let verdict) = screen.content else {
            Issue.record("Expected a verdict, got \(screen.content)")
            throw CancellationError()
        }
        return verdict
    }

    static func blocked(_ screen: SmartShiftScreen) throws -> String {
        guard case .blocked(let message) = screen.content else {
            Issue.record("Expected a blocked message, got \(screen.content)")
            throw CancellationError()
        }
        return message
    }

    /// iOS 17+ `DateFormatter` separates a time from AM/PM with a narrow no-break space.
    static func normalized(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    static func money(_ amount: Double) -> String { DashboardPresentation.currency(amount, code: "USD") }

    static func rate(_ value: Double) -> String { DashboardPresentation.loadRate(value, code: "USD") }

    /// 14 kWh over 5.9 h, matching the fixture lanes' draws.
    static let pump = LoadProfile(id: UUID().uuidString, name: "Pool pump", kind: .custom, energyKwh: 14,
                                  durationHours: 5.9, carSettings: nil)
}

/// One tariff span in a fixture's day, in hours from `at(0)`.
struct TariffSpan {
    let start: Double
    let end: Double
    let key: String

    init(_ start: Double, _ end: Double, _ key: String) {
        self.start = start
        self.end = end
        self.key = key
    }
}

/// One tariff span with its rates, in hours from `at(0)`.
struct RateSpan {
    let start: Double
    let end: Double
    let key: String
    let buy: Double
    let sell: Double

    init(_ start: Double, _ end: Double, _ key: String, _ buy: Double, _ sell: Double) {
        self.start = start
        self.end = end
        self.key = key
        self.buy = buy
        self.sell = sell
    }
}

/// A lane's six balances for a bill-date fixture.
struct BankValues {
    let start: Double
    let later: Double
    let startNow: Double
    let projected: Double
    let afterLater: Double
    let afterNow: Double

    init(_ start: Double, _ later: Double, _ startNow: Double,
         _ projected: Double, _ afterLater: Double, _ afterNow: Double) {
        self.start = start
        self.later = later
        self.startNow = startNow
        self.projected = projected
        self.afterLater = afterLater
        self.afterNow = afterNow
    }
}

/// The On-Peak and Off-Peak lanes of a bill-date fixture.
struct BankPair {
    let onPeak: BankValues
    let offPeak: BankValues
}

/// The three costs of a bill-date fixture, in dollars.
struct StartCosts {
    let costNow: Double
    let recommendedCost: Double
    let savings: Double
}

/// Harrison's tariff, its comparison, and the clock they were priced at.
struct HarrisonSunday {
    let timing: LoadTiming
    let comparison: LoadTimingForecastEstimator.Comparison
    let now: Date
    let car: LoadProfile
}
