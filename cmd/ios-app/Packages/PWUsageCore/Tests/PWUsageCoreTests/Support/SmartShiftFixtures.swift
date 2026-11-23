import Foundation
import PWUsageCore

/// Smart Shift clock and tariff fixtures shared by the core diagnostics tests and the app's
/// presentation tests (`project.yml` compiles this file into `PWUsageTests` too).
enum SmartShiftFixtures {
    typealias Estimator = LoadTimingForecastEstimator

    /// Local midnight in UTC; `start` in the estimator tests is 08:00 on this day.
    static let day0 = Date(timeIntervalSince1970: 1_800_000_000 - 8 * 3600)
    static func at(_ hours: Double) -> Date { day0.addingTimeInterval(hours * 3600) }
    static let now = at(8.5)
    static let horizonEnd = at(48)

    static func historyContext(asOf: Date, forecastHours: Bool = false) -> Estimator.PlanningContext {
        let slots = stride(from: 0, to: 1440, by: 30).map { minute in
            Estimator.PlanningSlot(localMinute: minute, homeKw: 0.5, batteryNetChargeKw: 0,
                                   gridNetExportKw: (480 ..< 1200).contains(minute) ? 2 : -0.5,
                                   cautiousGridNetExportKw: (480 ..< 1200).contains(minute) ? 1 : -0.5)
        }
        return .init(timeZone: "UTC", slots: slots, asOf: asOf)
    }

    /// The owner's Sunday at Harrison: Off-Peak all weekend (10¢ buy, 3¢ credit) and owed; Monday
    /// On-Peak 08:00–20:00 (31¢ buy, 4¢ credit) banks tomorrow's solar from +5 to +33. The car
    /// draws 52.7 kWh over 5.86 h; at 16:30 tomorrow 31.5 kWh lands in On-Peak and 21.2 after 20:00.
    static func harrisonSunday() -> HarrisonSunday {
        let now = at(13.2)
        let car = LoadProfile(id: "car", name: "Charge the car", kind: .car, energyKwh: 0, durationHours: 0,
                              carSettings: CarLoadSettings(capacityKwh: 79.05, initialStateOfCharge: 20,
                                                           targetStateOfCharge: 80, chargingLevel: .level2))
        let spans = [RateSpan(0, 32, "OFF_PEAK", 0.10, 0.03), RateSpan(32, 44, "ON_PEAK", 0.31, 0.04),
                     RateSpan(44, 48, "OFF_PEAK", 0.10, 0.03)]
        let segments = spans.map {
            LoadTimingTariffSegment(start: at($0.start), end: at($0.end), periodKey: $0.key, name: $0.key,
                                    buyRate: $0.buy, sellRate: $0.sell)
        }
        let periods = [("OFF_PEAK", -64.0, 0.10, 0.03), ("ON_PEAK", 5.0, 0.31, 0.04)].map {
            LoadTimingPeriod(name: $0.0, marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: $0.1,
                             isActive: false, nextStartPhrase: nil, buyRate: $0.2, sellRate: $0.3)
        }
        let timing = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: periods,
                                pricingPeriods: periods, tariffTimeline: segments, nextCheaper: nil,
                                nextCheaperPhrase: nil,
                                nextStartPhraseByKey: [:])
        func lane(_ key: String, start: Double, later: Double, startNow: Double) -> Estimator.BalanceLane {
            Estimator.BalanceLane(periodKey: key, startKwh: start,
                                  recommended: [.init(date: now, kwh: start), .init(date: horizonEnd, kwh: later)],
                                  startNow: [.init(date: now, kwh: start), .init(date: horizonEnd, kwh: startNow)])
        }
        let duration = 52.7 / 9
        let comparison = Estimator.Comparison(
            costNow: 5.27, recommendedStart: at(40.5), recommendedEnd: at(40.5 + duration), recommendedCost: 3.38,
            savings: 1.89, bestAlternativeSavings: 1.89, estimatedSolarContribution: 0, horizonStart: now,
            horizonEnd: horizonEnd, evaluatedStarts: [now, at(40.5)], assumptions: [], hasUnobservedBalance: false,
            lanes: [lane("OFF_PEAK", start: -64, later: -93.5, startNow: -125),
                    lane("ON_PEAK", start: 5, later: 1.5, startNow: 33)],
            periodSwitches: [at(32), at(44)])
        return HarrisonSunday(timing: timing, comparison: comparison, now: now, car: car)
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

/// Harrison's tariff, its comparison, and the clock they were priced at.
struct HarrisonSunday {
    let timing: LoadTiming
    let comparison: LoadTimingForecastEstimator.Comparison
    let now: Date
    let car: LoadProfile
}
