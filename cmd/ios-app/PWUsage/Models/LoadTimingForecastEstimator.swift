import Foundation

/// Compares one load against a signed billing-cycle balance using a device-local
/// solar forecast and the site's historical local-time household/battery profile.
struct LoadTimingForecastEstimator {
    static let maximumBalanceAge: TimeInterval = 30 * 60

    enum UnavailableReason: Equatable {
        case invalidInput
        case missingTariff
        case incompleteBalance
        case staleBalance
        case incompleteCoverage
        case incompleteContext
        case noFittingRun
        case noEnergyNeeded
    }

    struct PlanningSlot: Equatable {
        let localMinute: Int
        let homeKw: Double?
        let batteryNetChargeKw: Double?
    }

    struct PlanningContext: Equatable {
        let timeZone: String
        let slots: [PlanningSlot]
        let asOf: Date
    }

    struct Comparison: Equatable {
        let costNow: Double
        let recommendedStart: Date
        let recommendedEnd: Date
        let recommendedCost: Double
        let savings: Double
        let estimatedSolarContribution: Double
        let horizonStart: Date
        let horizonEnd: Date
        let evaluatedStarts: [Date]
        let assumptions: [String]
    }

    struct Result: Equatable {
        let comparison: Comparison?
        let unavailableReason: UnavailableReason?
    }

    private struct PeriodRate: Equatable {
        let buy: Double
        let sell: Double
    }

    private struct Candidate {
        let start: Date
        let end: Date
        let cost: Double
        let solarContribution: Double
    }

    private enum BaselineResult {
        case balances([String: Double])
        case invalidInput
        case incompleteCoverage
    }

    private enum ScoreResult {
        case candidate(Candidate)
        case invalidInput
        case incompleteCoverage
    }

    static func evaluate(
        profile: LoadProfile,
        now: Date,
        timing: LoadTiming,
        forecast: [SolarForecastInterval],
        context: PlanningContext,
        balanceSourceTime: Date,
        billingCycleEnd: Date,
        currencyCode: String
    ) -> Result {
        guard now.timeIntervalSince1970.isFinite, balanceSourceTime.timeIntervalSince1970.isFinite,
              billingCycleEnd.timeIntervalSince1970.isFinite, context.asOf.timeIntervalSince1970.isFinite,
              balanceSourceTime <= now else { return unavailable(.invalidInput) }
        guard now.timeIntervalSince(balanceSourceTime) <= maximumBalanceAge else { return unavailable(.staleBalance) }
        guard timing.hasTariff, !timing.tariffTimeline.isEmpty else { return unavailable(.missingTariff) }
        guard timing.hasCycleData else { return unavailable(.incompleteBalance) }
        guard let zone = TimeZone(identifier: context.timeZone) else { return unavailable(.invalidInput) }
        guard let load = loadShape(for: profile) else {
            if profile.kind == .car, let settings = profile.carSettings,
               let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings), estimate.wallKwh == 0 {
                return unavailable(.noEnergyNeeded)
            }
            return unavailable(.invalidInput)
        }
        let tariffs = timing.tariffTimeline.sorted { $0.start < $1.start }
        guard validTariffIntervals(tariffs), validForecast(forecast) else { return unavailable(.invalidInput) }

        let tomorrowEnd = endOfTomorrow(after: now, timeZone: zone)
        guard let tomorrowEnd, tomorrowEnd > now else { return unavailable(.invalidInput) }
        var horizonEnd = min(tomorrowEnd, billingCycleEnd)
        horizonEnd = min(horizonEnd, contiguousEnd(of: forecast, startingAt: balanceSourceTime))
        horizonEnd = min(horizonEnd, contiguousTariffEnd(tariffs, startingAt: balanceSourceTime))
        guard horizonEnd > now else { return unavailable(.incompleteCoverage) }

        // A rate change for one billing-period balance ends the shared search
        // horizon. Rates outside the horizon do not participate in validation.
        let rateSet = supportedRates(in: tariffs, from: balanceSourceTime, before: horizonEnd)
        guard !rateSet.invalid else { return unavailable(.invalidInput) }
        if let boundary = rateSet.incompatibleBoundary { horizonEnd = min(horizonEnd, boundary) }
        guard horizonEnd > now else { return unavailable(.incompleteCoverage) }

        if let contextGap = firstContextGap(from: balanceSourceTime, to: horizonEnd, forecast: forecast,
                                            tariffs: tariffs, context: context, timeZone: zone) {
            horizonEnd = min(horizonEnd, contextGap)
            guard horizonEnd > now else { return unavailable(.incompleteContext) }
        }

        let finalRateSet = supportedRates(in: tariffs, from: balanceSourceTime, before: horizonEnd)
        guard !finalRateSet.invalid else { return unavailable(.invalidInput) }
        let rates = finalRateSet.rates

        let observedBalances = Dictionary(timing.pricingPeriods.map { ($0.name, $0.cycleNetExportKwh) },
                                          uniquingKeysWith: { _, latest in latest })
        var balances: [String: Double] = [:]
        for key in rates.keys {
            guard let balance = observedBalances[key] else { return unavailable(.incompleteBalance) }
            guard balance.isFinite else { return unavailable(.incompleteBalance) }
            balances[key] = balance
        }
        guard !balances.isEmpty else { return unavailable(.incompleteBalance) }

        // Forecast/context/tariff coverage from the balance snapshot through the
        // shared horizon is needed even when a candidate run starts later.
        guard completeCoverage(from: balanceSourceTime, to: horizonEnd, forecast: forecast,
                               tariffs: tariffs, timeZone: zone) else {
            return unavailable(.incompleteCoverage)
        }

        let baseBalances: [String: Double]
        switch integrateBaseline(from: balanceSourceTime, to: horizonEnd, balances: balances,
                                 forecast: forecast, tariffs: tariffs, context: context, timeZone: zone) {
        case .balances(let projected): baseBalances = projected
        case .invalidInput: return unavailable(.invalidInput)
        case .incompleteCoverage: return unavailable(.incompleteCoverage)
        }
        let candidates = candidateStarts(now: now, horizonEnd: horizonEnd, duration: load.duration,
                                        forecast: forecast, tariffs: tariffs, timeZone: zone)
        var scored: [Candidate] = []
        for candidateStart in candidates {
            let candidateEnd = candidateStart.addingTimeInterval(load.duration)
            guard candidateStart >= now, candidateStart < horizonEnd else { continue }
            guard candidateEnd.timeIntervalSince1970.isFinite else { return unavailable(.invalidInput) }
            guard candidateEnd <= horizonEnd else { continue }
            switch score(start: candidateStart, end: candidateEnd, load: load,
                         baseBalances: baseBalances, rates: rates,
                         forecast: forecast, tariffs: tariffs, context: context, timeZone: zone) {
            case .candidate(let candidate): scored.append(candidate)
            case .invalidInput: return unavailable(.invalidInput)
            case .incompleteCoverage: return unavailable(.incompleteCoverage)
            }
        }
        guard let nowCandidate = scored.first(where: { $0.start == now }) else { return unavailable(.noFittingRun) }
        guard let best = scored.min(by: { $0.cost == $1.cost ? $0.start < $1.start : $0.cost < $1.cost }) else {
            return unavailable(.noFittingRun)
        }
        let rawSavings = nowCandidate.cost - best.cost
        guard rawSavings.isFinite else { return unavailable(.invalidInput) }
        let savings = max(0, rawSavings)
        let minorUnit = currencyMinorUnit(currencyCode)
        let recommendation = savings > minorUnit ? best : nowCandidate
        return Result(comparison: Comparison(
            costNow: nowCandidate.cost,
            recommendedStart: recommendation.start,
            recommendedEnd: recommendation.end,
            recommendedCost: recommendation.cost,
            savings: recommendation.start == nowCandidate.start ? 0 : savings,
            estimatedSolarContribution: recommendation.solarContribution,
            horizonStart: now,
            horizonEnd: horizonEnd,
            evaluatedStarts: scored.map(\.start).sorted(),
            assumptions: [
                "Typical household and battery behavior follows the historical local-time profile.",
                "Battery behavior is assumed unchanged by this added load.",
                "Recommendation is the best among evaluated start times, not a continuous-time optimum.",
                "Estimated cost uses the current signed period balances through the shared horizon."
            ]
        ), unavailableReason: nil)
    }

    static func currencyMinorUnit(_ currencyCode: String) -> Double {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .currency
        formatter.currencyCode = currencyCode
        let digits = min(max(formatter.maximumFractionDigits, 0), 6)
        return pow(10, -Double(digits))
    }

    private static func unavailable(_ reason: UnavailableReason) -> Result {
        Result(comparison: nil, unavailableReason: reason)
    }

    private static func loadShape(for profile: LoadProfile) -> (energy: Double, duration: TimeInterval)? {
        if profile.kind == .car {
            guard let settings = profile.carSettings,
                  let charge = LoadTimingEstimator.carChargeEstimate(settings: settings),
                  charge.wallKwh > 0, charge.durationHours > 0 else { return nil }
            return validatedLoadShape(energy: charge.wallKwh, durationHours: charge.durationHours)
        }
        guard profile.energyKwh.isFinite, profile.energyKwh > 0,
              profile.durationHours.isFinite, profile.durationHours > 0 else { return nil }
        return validatedLoadShape(energy: profile.energyKwh, durationHours: profile.durationHours)
    }

    private static func validatedLoadShape(energy: Double, durationHours: Double) -> (energy: Double, duration: TimeInterval)? {
        let duration = durationHours * 3600
        let powerKw = energy / durationHours
        guard energy.isFinite, energy > 0, durationHours.isFinite, durationHours > 0,
              duration.isFinite, duration > 0, powerKw.isFinite, powerKw > 0 else { return nil }
        return (energy, duration)
    }

    private static func validTariffIntervals(_ tariffs: [LoadTimingTariffSegment]) -> Bool {
        guard !tariffs.isEmpty else { return false }
        var end: Date?
        for tariff in tariffs {
            guard tariff.start.timeIntervalSince1970.isFinite, tariff.end.timeIntervalSince1970.isFinite,
                  tariff.end > tariff.start else { return false }
            if let end, tariff.start < end { return false }
            end = tariff.end
        }
        return true
    }

    private static func validForecast(_ forecast: [SolarForecastInterval]) -> Bool {
        guard !forecast.isEmpty else { return false }
        var end: Date?
        for interval in forecast.sorted(by: { $0.periodStart < $1.periodStart }) {
            guard interval.periodStart.timeIntervalSince1970.isFinite, interval.periodEnd.timeIntervalSince1970.isFinite,
                  interval.periodEnd > interval.periodStart, interval.powerKw.isFinite, interval.powerKw >= 0 else { return false }
            if let end, interval.periodStart < end { return false }
            end = interval.periodEnd
        }
        return true
    }

    private static func supportedRates(in tariffs: [LoadTimingTariffSegment], from source: Date, before horizonEnd: Date)
        -> (rates: [String: PeriodRate], incompatibleBoundary: Date?, invalid: Bool) {
        var values: [String: PeriodRate] = [:]
        for tariff in tariffs where tariff.end > source && tariff.start < horizonEnd {
            guard !tariff.periodKey.isEmpty, tariff.buyRate.isFinite, tariff.sellRate.isFinite else {
                return (values, nil, true)
            }
            let rate = PeriodRate(buy: tariff.buyRate, sell: tariff.sellRate)
            if let old = values[tariff.periodKey], old != rate {
                return (values, tariff.start, false)
            }
            values[tariff.periodKey] = rate
        }
        return (values, nil, false)
    }

    private static func contiguousEnd(of forecast: [SolarForecastInterval], startingAt source: Date) -> Date {
        let intervals = forecast.sorted { $0.periodStart < $1.periodStart }
        guard let first = intervals.first(where: { $0.periodStart <= source && $0.periodEnd > source }) else { return source }
        var end = first.periodEnd
        for interval in intervals where interval.periodStart >= end {
            guard interval.periodStart == end else { break }
            end = interval.periodEnd
        }
        return end
    }

    private static func contiguousTariffEnd(_ tariffs: [LoadTimingTariffSegment], startingAt source: Date) -> Date {
        var end: Date?
        for tariff in tariffs where tariff.end > source {
            if end == nil {
                guard tariff.start <= source else { return source }
                end = tariff.end
            } else if tariff.start == end {
                end = tariff.end
            } else if tariff.start > end! {
                break
            }
        }
        return end ?? source
    }

    private static func endOfTomorrow(after date: Date, timeZone: TimeZone) -> Date? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let startOfToday = calendar.dateInterval(of: .day, for: date)?.start else { return nil }
        return calendar.date(byAdding: .day, value: 2, to: startOfToday)
    }

    private static func completeCoverage(from start: Date, to end: Date, forecast: [SolarForecastInterval],
                                         tariffs: [LoadTimingTariffSegment], timeZone: TimeZone) -> Bool {
        guard start < end else { return false }
        let points = integrationBoundaries(from: start, to: end, forecast: forecast, tariffs: tariffs, timeZone: timeZone)
        guard points.count >= 2 else { return false }
        for index in 0..<(points.count - 1) {
            let a = points[index]
            let b = points[index + 1]
            guard b > a else { return false }
            let midpoint = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
            guard forecast.contains(where: { $0.periodStart <= midpoint && midpoint < $0.periodEnd }),
                  tariffs.contains(where: { $0.start <= midpoint && midpoint < $0.end }) else { return false }
        }
        return points.first == start && points.last == end
    }

    private static func firstContextGap(from start: Date, to end: Date, forecast: [SolarForecastInterval],
                                        tariffs: [LoadTimingTariffSegment], context: PlanningContext,
                                        timeZone: TimeZone) -> Date? {
        guard start < end else { return start }
        let points = integrationBoundaries(from: start, to: end, forecast: forecast, tariffs: tariffs, timeZone: timeZone)
        guard points.count >= 2 else { return start }
        for index in 0..<(points.count - 1) {
            let midpoint = points[index].addingTimeInterval(points[index + 1].timeIntervalSince(points[index]) / 2)
            guard slot(at: midpoint, context: context, timeZone: timeZone) != nil else { return points[index] }
        }
        return nil
    }

    private static func integrationBoundaries(from start: Date, to end: Date, forecast: [SolarForecastInterval],
                                              tariffs: [LoadTimingTariffSegment], timeZone: TimeZone) -> [Date] {
        var values: Set<Date> = [start, end]
        for interval in forecast {
            if interval.periodStart > start && interval.periodStart < end { values.insert(interval.periodStart) }
            if interval.periodEnd > start && interval.periodEnd < end { values.insert(interval.periodEnd) }
        }
        for segment in tariffs {
            if segment.start > start && segment.start < end { values.insert(segment.start) }
            if segment.end > start && segment.end < end { values.insert(segment.end) }
        }
        // Context values change on local half-hour boundaries. Scan minute
        // boundaries so non-hour offsets and DST transitions are honored.
        var cursor = Date(timeIntervalSince1970: floor(start.timeIntervalSince1970 / 60) * 60 + 60)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        while cursor < end {
            let minute = calendar.component(.minute, from: cursor)
            if minute.isMultiple(of: 30) { values.insert(cursor) }
            cursor = cursor.addingTimeInterval(60)
        }
        return values.sorted()
    }

    private static func slot(at date: Date, context: PlanningContext, timeZone: TimeZone) -> PlanningSlot? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let localMinute = calendar.component(.hour, from: date) * 60 + calendar.component(.minute, from: date)
        let slotMinute = (localMinute / 30) * 30
        let matches = context.slots.filter { $0.localMinute == slotMinute }
        guard matches.count == 1, let match = matches.first,
              match.localMinute >= 0, match.localMinute < 1440, match.localMinute.isMultiple(of: 30),
              let home = match.homeKw, let battery = match.batteryNetChargeKw,
              home.isFinite, battery.isFinite else { return nil }
        return match
    }

    private static func integrateBaseline(from start: Date, to end: Date, balances: [String: Double],
                                          forecast: [SolarForecastInterval], tariffs: [LoadTimingTariffSegment],
                                          context: PlanningContext, timeZone: TimeZone) -> BaselineResult {
        var result = balances
        let points = integrationBoundaries(from: start, to: end, forecast: forecast, tariffs: tariffs, timeZone: timeZone)
        guard points.count >= 2 else { return .incompleteCoverage }
        for index in 0..<(points.count - 1) {
            let a = points[index], b = points[index + 1]
            let mid = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
            guard let solarPower = forecast.first(where: { $0.periodStart <= mid && mid < $0.periodEnd })?.powerKw,
                  let tariff = tariffs.first(where: { $0.start <= mid && mid < $0.end }),
                  let profile = slot(at: mid, context: context, timeZone: timeZone),
                  let home = profile.homeKw, let battery = profile.batteryNetChargeKw,
                  let old = result[tariff.periodKey] else { return .incompleteCoverage }
            let seconds = b.timeIntervalSince(a)
            let hours = seconds / 3600
            let netPower = solarPower - home - battery
            let netExport = netPower * hours
            let updated = old + netExport
            guard seconds.isFinite, hours.isFinite, netPower.isFinite, netExport.isFinite, updated.isFinite else {
                return .invalidInput
            }
            result[tariff.periodKey] = updated
        }
        return .balances(result)
    }

    private static func score(start: Date, end: Date, load: (energy: Double, duration: TimeInterval),
                              baseBalances: [String: Double], rates: [String: PeriodRate],
                              forecast: [SolarForecastInterval], tariffs: [LoadTimingTariffSegment],
                              context: PlanningContext, timeZone: TimeZone) -> ScoreResult {
        var withLoad = baseBalances
        var solarContribution = 0.0
        let points = integrationBoundaries(from: start, to: end, forecast: forecast, tariffs: tariffs, timeZone: timeZone)
        guard points.count >= 2 else { return .incompleteCoverage }
        let powerKw = load.energy / (load.duration / 3600)
        guard powerKw.isFinite, powerKw > 0 else { return .invalidInput }
        for index in 0..<(points.count - 1) {
            let a = points[index], b = points[index + 1]
            let mid = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
            guard let solar = forecast.first(where: { $0.periodStart <= mid && mid < $0.periodEnd })?.powerKw,
                  let tariff = tariffs.first(where: { $0.start <= mid && mid < $0.end }),
                  let profile = slot(at: mid, context: context, timeZone: timeZone),
                  let home = profile.homeKw, let battery = profile.batteryNetChargeKw,
                  let balance = withLoad[tariff.periodKey] else { return .incompleteCoverage }
            let seconds = b.timeIntervalSince(a)
            let hours = seconds / 3600
            let energy = powerKw * hours
            let loadedBalance = balance - energy
            let physicalSurplus = solar - home - max(battery, 0)
            let physicalSurplusPower = max(physicalSurplus, 0)
            let contribution = min(powerKw, physicalSurplusPower) * hours
            let updatedSolarContribution = solarContribution + contribution
            guard seconds.isFinite, hours.isFinite, energy.isFinite, loadedBalance.isFinite,
                  physicalSurplus.isFinite, physicalSurplusPower.isFinite,
                  contribution.isFinite, updatedSolarContribution.isFinite else { return .invalidInput }
            withLoad[tariff.periodKey] = loadedBalance
            solarContribution = updatedSolarContribution
        }
        var total = 0.0
        for (key, loadedBalance) in withLoad where loadedBalance != baseBalances[key] {
            guard let baselineBalance = baseBalances[key], let rate = rates[key] else { return .incompleteCoverage }
            guard let loadedCost = cost(balance: loadedBalance, rate: rate),
                  let baselineCost = cost(balance: baselineBalance, rate: rate) else { return .invalidInput }
            let delta = loadedCost - baselineCost
            let updatedTotal = total + delta
            guard delta.isFinite, updatedTotal.isFinite else { return .invalidInput }
            total = updatedTotal
        }
        let cappedSolarContribution = min(max(solarContribution, 0), load.energy)
        guard total.isFinite, cappedSolarContribution.isFinite else { return .invalidInput }
        return .candidate(Candidate(start: start, end: end, cost: total,
                                    solarContribution: cappedSolarContribution))
    }

    private static func cost(balance: Double, rate: PeriodRate) -> Double? {
        let importCost = max(-balance, 0) * rate.buy
        let exportCredit = max(balance, 0) * rate.sell
        let total = importCost - exportCredit
        guard importCost.isFinite, exportCredit.isFinite, total.isFinite else { return nil }
        return total
    }

    private static func candidateStarts(now: Date, horizonEnd: Date, duration: TimeInterval,
                                        forecast: [SolarForecastInterval], tariffs: [LoadTimingTariffSegment],
                                        timeZone: TimeZone) -> [Date] {
        var starts: Set<Date> = [now]
        for interval in forecast {
            if interval.periodStart >= now && interval.periodStart < horizonEnd { starts.insert(interval.periodStart) }
            if interval.periodEnd >= now && interval.periodEnd < horizonEnd { starts.insert(interval.periodEnd) }
        }
        for tariff in tariffs {
            if tariff.start >= now && tariff.start < horizonEnd { starts.insert(tariff.start) }
            if tariff.end >= now && tariff.end < horizonEnd { starts.insert(tariff.end) }
            let before = tariff.start.addingTimeInterval(-duration)
            if before >= now && before < horizonEnd { starts.insert(before) }
            let beforeEnd = tariff.end.addingTimeInterval(-duration)
            if beforeEnd >= now && beforeEnd < horizonEnd { starts.insert(beforeEnd) }
        }
        // Use the site's wall-clock half-hour boundaries. This also covers zones
        // whose UTC offset is a quarter hour and naturally follows DST changes.
        var boundary = Date(timeIntervalSince1970: floor(now.timeIntervalSince1970 / 60) * 60 + 60)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        while boundary < horizonEnd {
            let minute = calendar.component(.minute, from: boundary)
            let second = calendar.component(.second, from: boundary)
            if minute.isMultiple(of: 30) && second == 0 { starts.insert(boundary) }
            boundary = boundary.addingTimeInterval(60)
        }
        return starts.sorted()
    }
}
