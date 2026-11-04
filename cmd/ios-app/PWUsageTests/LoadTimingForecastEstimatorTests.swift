import Foundation
@testable import PWUsage
import Testing

struct LoadTimingForecastEstimatorTests {
    let start = Date(timeIntervalSince1970: 1_800_000_000)

    func profile(_ kwh: Double = 3, hours: Double = 1) -> LoadProfile {
        LoadProfile(id: "load", name: "Load", kind: .appliance, energyKwh: kwh, durationHours: hours, carSettings: nil)
    }

    func tariff(_ from: TimeInterval, _ through: TimeInterval, key: String = "p", buy: Double = 0.30,
                sell: Double = 0.05) -> LoadTimingTariffSegment {
        LoadTimingTariffSegment(start: start.addingTimeInterval(from), end: start.addingTimeInterval(through),
                                periodKey: key, name: key, buyRate: buy, sellRate: sell)
    }

    func timing(_ segments: [LoadTimingTariffSegment], balances: [String: Double] = ["p": 2],
                pricingBalances: [String: Double]? = nil, hasCycleData: Bool = true) -> LoadTiming {
        let periods = balances.map { key, value in
            LoadTimingPeriod(name: key, marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: value,
                             isActive: false, nextStartPhrase: nil,
                             buyRate: segments.first(where: { $0.periodKey == key })?.buyRate ?? 0.30,
                             sellRate: segments.first(where: { $0.periodKey == key })?.sellRate ?? 0.05)
        }
        let pricing = (pricingBalances ?? balances).map { key, value in
            LoadTimingPeriod(name: key, marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: value,
                             isActive: false, nextStartPhrase: nil,
                             buyRate: segments.first(where: { $0.periodKey == key })?.buyRate ?? 0.30,
                             sellRate: segments.first(where: { $0.periodKey == key })?.sellRate ?? 0.05)
        }
        return LoadTiming(hasTariff: true, hasCycleData: hasCycleData, activeIsCheapest: false, periods: periods,
                          pricingPeriods: pricing, tariffTimeline: segments, nextCheaper: nil, nextCheaperPhrase: nil,
                          nextStartPhraseByKey: [:])
    }

    func forecast(_ power: Double, from: TimeInterval, to end: TimeInterval) -> SolarForecastInterval {
        SolarForecastInterval(periodStart: start.addingTimeInterval(from), periodEnd: start.addingTimeInterval(end),
                              powerKw: power)
    }

    func context(home: Double = 0, battery: Double = 0) -> LoadTimingForecastEstimator.PlanningContext {
        let slots = stride(from: 0, to: 1440, by: 30).map {
            LoadTimingForecastEstimator.PlanningSlot(localMinute: $0, homeKw: home, batteryNetChargeKw: battery)
        }
        return .init(timeZone: "UTC", slots: slots, asOf: start)
    }

    func evaluate(
        profile: LoadProfile? = nil,
        now: TimeInterval = 0,
        tariffs: [LoadTimingTariffSegment],
        balances: [String: Double] = ["p": 2],
        pricingBalances: [String: Double]? = nil,
        hasCycleData: Bool = true,
        forecast: [SolarForecastInterval],
        context: LoadTimingForecastEstimator.PlanningContext? = nil,
        balanceSource: TimeInterval = 0,
        cycleEnd: TimeInterval = 172_800,
        currencyCode: String = "USD"
    ) -> LoadTimingForecastEstimator.Result {
        let plan = LoadTimingForecastEstimator.plan(.init(
            now: start.addingTimeInterval(now),
            timing: timing(tariffs, balances: balances, pricingBalances: pricingBalances, hasCycleData: hasCycleData),
            projection: .forecast(intervals: forecast, context: context ?? self.context()),
            balanceSourceTime: start.addingTimeInterval(balanceSource),
            billingCycleEnd: start.addingTimeInterval(cycleEnd), currencyCode: currencyCode
        ))
        return LoadTimingForecastEstimator.evaluate(profile: profile ?? self.profile(), plan: plan)
    }

    // MARK: - Flat (forecast-free) projection

    /// Local midnight (UTC) on the day of `start`, which is 08:00 UTC.
    var day0: Date { start.addingTimeInterval(-8 * 3600) }

    func hours(_ value: Double) -> Date { day0.addingTimeInterval(value * 3600) }

    /// Peak 07:00–16:30 (buy 0.38, sell 0.10), Off-Peak otherwise (buy 0.20, sell 0.26), for two days.
    func peakOffPeakTariffs() -> [LoadTimingTariffSegment] {
        let peak = (buy: 0.38, sell: 0.10), offPeak = (buy: 0.20, sell: 0.26)
        let spans = [HourSpan(0, 7, "Off-Peak"), HourSpan(7, 16.5, "Peak"), HourSpan(16.5, 31, "Off-Peak"),
                     HourSpan(31, 40.5, "Peak"), HourSpan(40.5, 48, "Off-Peak")]
        return spans.map { span in
            let rate = span.key == "Peak" ? peak : offPeak
            return LoadTimingTariffSegment(start: hours(span.start), end: hours(span.end), periodKey: span.key,
                                           name: span.key, buyRate: rate.buy, sellRate: rate.sell)
        }
    }

    func evaluateFlat(
        profile: LoadProfile,
        now: Date,
        tariffs: [LoadTimingTariffSegment],
        balances: [String: Double],
        pricingBalances: [String: Double]? = nil,
        balanceSource: Date? = nil,
        cycleEnd: Date? = nil,
        timeZone: String = "UTC"
    ) -> LoadTimingForecastEstimator.Result {
        let plan = LoadTimingForecastEstimator.plan(.init(
            now: now,
            timing: timing(tariffs, balances: balances, pricingBalances: pricingBalances),
            projection: .flat(timeZone: timeZone), balanceSourceTime: balanceSource ?? now,
            billingCycleEnd: cycleEnd ?? now.addingTimeInterval(7 * 86_400), currencyCode: "USD"
        ))
        return LoadTimingForecastEstimator.evaluate(profile: profile, plan: plan)
    }

    // MARK: - Balance lanes

    func lane(
        _ key: String, in comparison: LoadTimingForecastEstimator.Comparison
    ) throws -> LoadTimingForecastEstimator.BalanceLane {
        try #require(comparison.lanes.first { $0.periodKey == key })
    }

    typealias Estimator = LoadTimingForecastEstimator

    /// A planning context whose slots carry grid history (`grid(localMinute)` kW).
    func historyContext(
        timeZone: String = "UTC",
        home: Double = 0,
        battery: Double = 0,
        grid: (Int) -> Double?,
        cautious: ((Int) -> Double?)? = nil
    ) -> Estimator.PlanningContext {
        let slots = stride(from: 0, to: 1440, by: 30).map { minute in
            Estimator.PlanningSlot(localMinute: minute, homeKw: home, batteryNetChargeKw: battery,
                                   gridNetExportKw: grid(minute), cautiousGridNetExportKw: cautious?(minute))
        }
        return .init(timeZone: timeZone, slots: slots, asOf: start)
    }

    func evaluate(
        _ projection: Estimator.Projection,
        profile: LoadProfile? = nil,
        now: Date,
        tariffs: [LoadTimingTariffSegment],
        balances: [String: Double],
        cycleEnd: Date
    ) -> Estimator.Result {
        let plan = Estimator.plan(.init(now: now, timing: timing(tariffs, balances: balances),
                                        projection: projection, balanceSourceTime: now,
                                        billingCycleEnd: cycleEnd, currencyCode: "USD"))
        return Estimator.evaluate(profile: profile ?? self.profile(), plan: plan)
    }

    /// Daily UTC segments from 00:00 on `start`'s day: On-Peak 08:00–20:00 on
    /// days `onPeakDay(dayIndex)` allows, Off-Peak otherwise.
    func dailyTariffs(days: Int, onBuy: Double = 0.31, onSell: Double = 0.04, offBuy: Double = 0.10,
                      offSell: Double = 0.03,
                      onPeakDay: (Int) -> Bool = { _ in true }) -> [LoadTimingTariffSegment] {
        let dayZero = start.addingTimeInterval(-8 * 3600)
        func segment(_ day: Int, _ begin: Double, _ end: Double, _ key: String) -> LoadTimingTariffSegment {
            let base = dayZero.addingTimeInterval(Double(day) * 86_400)
            let isOnPeak = key == "ON_PEAK"
            return LoadTimingTariffSegment(start: base.addingTimeInterval(begin * 3600),
                                           end: base.addingTimeInterval(end * 3600),
                                           periodKey: key, name: isOnPeak ? "On-Peak" : "Off-Peak",
                                           buyRate: isOnPeak ? onBuy : offBuy, sellRate: isOnPeak ? onSell : offSell)
        }
        return (0 ..< days).flatMap { day in
            onPeakDay(day)
                ? [segment(day, 0, 8, "OFF_PEAK"), segment(day, 8, 20, "ON_PEAK"), segment(day, 20, 24, "OFF_PEAK")]
                : [segment(day, 0, 24, "OFF_PEAK")]
        }
    }

    static func isDaylight(_ minute: Int) -> Bool { minute >= 480 && minute < 1200 }

    /// Half-hour intervals over [0, hours) from `start`, typical and cautious kW by hour offset.
    func halfHourForecast(hours: Int, typical: (Double) -> Double,
                          cautious: ((Double) -> Double?)?) -> [SolarForecastInterval] {
        (0 ..< (hours * 2)).map { index in
            let hour = Double(index) / 2
            return SolarForecastInterval(periodStart: start.addingTimeInterval(hour * 3600),
                                         periodEnd: start.addingTimeInterval((hour + 0.5) * 3600),
                                         powerKw: typical(hour), cautiousPowerKw: cautious?(hour))
        }
    }

    func safetyEvaluate(
        forecast: [SolarForecastInterval],
        tariffs: [LoadTimingTariffSegment],
        balances: [String: Double],
        profile: LoadProfile,
        home: Double = 0
    ) -> LoadTimingForecastEstimator.Result {
        let projection = LoadTimingForecastEstimator.Projection.forecast(
            intervals: forecast, context: historyContext(home: home, grid: { _ in 0 }))
        let plan = LoadTimingForecastEstimator.plan(.init(
            now: start, timing: timing(tariffs, balances: balances),
            // Zero grid history: the rule applies only when history is served.
            projection: projection, balanceSourceTime: start,
            billingCycleEnd: start.addingTimeInterval(20 * 86_400), currencyCode: "USD"
        ))
        return LoadTimingForecastEstimator.evaluate(profile: profile, plan: plan)
    }

    func load(_ kwh: Double, hours: Double) -> LoadProfile {
        LoadProfile(id: "job", name: "Job", kind: .appliance, energyKwh: kwh, durationHours: hours, carSettings: nil)
    }
}

/// One tariff period in hours from the suite's `start`.
struct HourSpan {
    let start: Double
    let end: Double
    let key: String

    init(_ start: Double, _ end: Double, _ key: String) {
        self.start = start
        self.end = end
        self.key = key
    }
}
