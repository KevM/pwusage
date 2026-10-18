import Foundation

/// Compares one load against a signed billing-cycle balance using a device-local
/// solar forecast and the site's historical local-time household/battery profile.
struct LoadTimingForecastEstimator {
    static let maximumBalanceAge: TimeInterval = 30 * 60
    /// The forecast-free comparison follows `LoadTimingRecommendation`'s freshness window.
    static let maximumFlatBalanceAge: TimeInterval = 60 * 60
    /// Each `EnergyData` row holds signed energy for a five-minute interval and
    /// its timestamp marks that interval's start, so the cycle balance already
    /// includes the interval beginning at `balanceSourceTime`. Projecting the
    /// baseline from that same timestamp would count the latest interval twice.
    static let observedIntervalDuration: TimeInterval = 5 * 60

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

    /// How balances move between now and the end of the search horizon.
    /// `.forecast` projects solar and typical household use; `.flat` holds each
    /// period's balance at today's observed value, so only the job moves it.
    enum Projection: Equatable {
        case forecast(intervals: [SolarForecastInterval], context: PlanningContext)
        case flat(timeZone: String)

        var timeZone: String {
            switch self {
            case .forecast(_, let context): context.timeZone
            case .flat(let timeZone): timeZone
            }
        }

        var maximumBalanceAge: TimeInterval {
            switch self {
            case .forecast: LoadTimingForecastEstimator.maximumBalanceAge
            case .flat: LoadTimingForecastEstimator.maximumFlatBalanceAge
            }
        }

        /// Solar intervals whose edges are integration and candidate boundaries; none for `.flat`.
        var intervals: [SolarForecastInterval] {
            switch self {
            case .forecast(let intervals, _): intervals
            case .flat: []
            }
        }
    }

    struct Comparison: Equatable {
        /// The **marginal** cost of running the load now against the projected
        /// household baseline — `Σ (cost(withLoad) − cost(baseline))` over the
        /// run's intervals. This is *not* the absolute cost of the energy
        /// involved. When the load is served by stored surplus the marginal cost
        /// approaches zero, and zero is the right answer, because that energy was
        /// already paid for. A reader assuming "total" will draw the wrong
        /// conclusion, so callers must present it as an addition to the bill.
        let costNow: Double
        let recommendedStart: Date
        let recommendedEnd: Date
        /// The **marginal** cost of running the load at `recommendedStart`, defined
        /// and constrained exactly as `costNow` is. Like `costNow` it is a delta
        /// against the projected household baseline, never the absolute cost of the
        /// run, and a near-zero value means the load is served by stored surplus.
        let recommendedCost: Double
        let savings: Double
        /// Raw saving of the cheapest non-now start, before the minor-unit
        /// threshold. Lets the UI distinguish "nothing cheaper exists" from
        /// "waiting would save a rounding error" without inventing a saving.
        let bestAlternativeSavings: Double
        let estimatedSolarContribution: Double
        let horizonStart: Date
        let horizonEnd: Date
        let evaluatedStarts: [Date]
        let assumptions: [String]
        /// A rate period the runs could touch has no observed balance, so it was
        /// priced from zero (at the buy rate). Only the `.flat` projection allows this.
        let hasUnobservedBalance: Bool
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

    /// Household flow at one instant: what the baseline exports to the grid, and the
    /// solar left over after the home and any battery charging, which an added load can use.
    private struct Flow {
        let netExportKw: Double
        let physicalSurplusKw: Double
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
        evaluate(profile: profile, now: now, timing: timing, projection: .forecast(intervals: forecast, context: context),
                 balanceSourceTime: balanceSourceTime, billingCycleEnd: billingCycleEnd, currencyCode: currencyCode)
    }

    static func evaluate(
        profile: LoadProfile,
        now: Date,
        timing: LoadTiming,
        projection: Projection,
        balanceSourceTime: Date,
        billingCycleEnd: Date,
        currencyCode: String
    ) -> Result {
        guard now.timeIntervalSince1970.isFinite, balanceSourceTime.timeIntervalSince1970.isFinite,
              billingCycleEnd.timeIntervalSince1970.isFinite, balanceSourceTime <= now else { return unavailable(.invalidInput) }
        if case .forecast(_, let context) = projection, !context.asOf.timeIntervalSince1970.isFinite {
            return unavailable(.invalidInput)
        }
        guard now.timeIntervalSince(balanceSourceTime) <= projection.maximumBalanceAge else { return unavailable(.staleBalance) }
        guard timing.hasTariff, !timing.tariffTimeline.isEmpty else { return unavailable(.missingTariff) }
        if case .forecast = projection, !timing.hasCycleData { return unavailable(.incompleteBalance) }
        guard let zone = TimeZone(identifier: projection.timeZone) else { return unavailable(.invalidInput) }
        guard let load = loadShape(for: profile) else {
            if profile.kind == .car, let settings = profile.carSettings,
               let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings), estimate.wallKwh == 0 {
                return unavailable(.noEnergyNeeded)
            }
            return unavailable(.invalidInput)
        }
        let tariffs = timing.tariffTimeline.sorted { $0.start < $1.start }
        guard validTariffIntervals(tariffs) else { return unavailable(.invalidInput) }
        if case .forecast(let forecast, _) = projection, !validForecast(forecast) { return unavailable(.invalidInput) }

        // The balance already covers observed data through the end of the final
        // five-minute interval, so projection starts there rather than at
        // `balanceSourceTime`, and never after the present.
        let projectionStart = min(balanceSourceTime.addingTimeInterval(Self.observedIntervalDuration), now)

        let tomorrowEnd = endOfTomorrow(after: now, timeZone: zone)
        guard let tomorrowEnd, tomorrowEnd > now else { return unavailable(.invalidInput) }
        var horizonEnd = min(tomorrowEnd, billingCycleEnd)
        if case .forecast(let forecast, _) = projection {
            horizonEnd = min(horizonEnd, contiguousEnd(of: forecast, startingAt: projectionStart))
        }
        horizonEnd = min(horizonEnd, contiguousTariffEnd(tariffs, startingAt: projectionStart))
        guard horizonEnd > now else { return unavailable(.incompleteCoverage) }

        // A rate change for one billing-period balance ends the shared search
        // horizon. Rates outside the horizon do not participate in validation.
        let rateSet = supportedRates(in: tariffs, from: balanceSourceTime, before: horizonEnd)
        guard !rateSet.invalid else { return unavailable(.invalidInput) }
        if let boundary = rateSet.incompatibleBoundary { horizonEnd = min(horizonEnd, boundary) }
        guard horizonEnd > now else { return unavailable(.incompleteCoverage) }

        if let contextGap = firstContextGap(from: projectionStart, to: horizonEnd, projection: projection,
                                            tariffs: tariffs, timeZone: zone) {
            horizonEnd = min(horizonEnd, contextGap)
            guard horizonEnd > now else { return unavailable(.incompleteContext) }
        }

        let finalRateSet = supportedRates(in: tariffs, from: balanceSourceTime, before: horizonEnd)
        guard !finalRateSet.invalid else { return unavailable(.invalidInput) }
        var rates = finalRateSet.rates

        // Like `LoadTimingRecommendation`, the forecast-free path reads no balances
        // when the cycle has no data yet, so every period is priced from zero.
        let observedBalances: [String: Double] = timing.hasCycleData
            ? Dictionary(timing.pricingPeriods.map { ($0.name, $0.cycleNetExportKwh) }, uniquingKeysWith: { _, latest in latest })
            : [:]

        var balances: [String: Double] = [:]
        var hasUnobservedBalance = false
        switch projection {
        case .forecast:
            // A tariff period with no observed balance cannot be projected. If it has
            // not started yet — a seasonal schedule boundary, for example — end the
            // shared horizon there instead of discarding the whole comparison. If it
            // is already under way the baseline is unsound, so reject.
            if let firstUnbalanced = rates.keys.compactMap({ key -> Date? in
                guard observedBalances[key] == nil else { return nil }
                return tariffs.first(where: { $0.periodKey == key && $0.start < horizonEnd })?.start
            }).min() {
                guard firstUnbalanced > now else { return unavailable(.incompleteBalance) }
                horizonEnd = min(horizonEnd, firstUnbalanced)
                guard horizonEnd > now else { return unavailable(.incompleteCoverage) }
                let truncated = supportedRates(in: tariffs, from: balanceSourceTime, before: horizonEnd)
                guard !truncated.invalid else { return unavailable(.invalidInput) }
                rates = truncated.rates
            }
            for key in rates.keys {
                guard let balance = observedBalances[key] else { return unavailable(.incompleteBalance) }
                guard balance.isFinite else { return unavailable(.incompleteBalance) }
                balances[key] = balance
            }
        case .flat:
            // Held still, an unobserved period is simply priced from zero, as
            // `LoadTimingEstimator.estimateStartNow` does, and flagged for the UI.
            for key in rates.keys {
                if let balance = observedBalances[key] {
                    guard balance.isFinite else { return unavailable(.incompleteBalance) }
                    balances[key] = balance
                } else {
                    balances[key] = 0
                    hasUnobservedBalance = true
                }
            }
        }
        guard !balances.isEmpty else { return unavailable(.incompleteBalance) }

        // Forecast/context/tariff coverage from the end of observed data through
        // the shared horizon is needed even when a candidate run starts later.
        guard completeCoverage(from: projectionStart, to: horizonEnd, projection: projection,
                               tariffs: tariffs, timeZone: zone) else {
            return unavailable(.incompleteCoverage)
        }

        let baseBalances: [String: Double]
        switch integrateBaseline(from: projectionStart, to: horizonEnd, balances: balances,
                                 projection: projection, tariffs: tariffs, timeZone: zone) {
        case .balances(let projected): baseBalances = projected
        case .invalidInput: return unavailable(.invalidInput)
        case .incompleteCoverage: return unavailable(.incompleteCoverage)
        }
        let candidates = candidateStarts(now: now, horizonEnd: horizonEnd, duration: load.duration,
                                        projection: projection, tariffs: tariffs, timeZone: zone)
        var scored: [Candidate] = []
        for candidateStart in candidates {
            let candidateEnd = candidateStart.addingTimeInterval(load.duration)
            guard candidateStart >= now, candidateStart < horizonEnd else { continue }
            guard candidateEnd.timeIntervalSince1970.isFinite else { return unavailable(.invalidInput) }
            guard candidateEnd <= horizonEnd else { continue }
            switch score(start: candidateStart, end: candidateEnd, load: load,
                         baseBalances: baseBalances, rates: rates,
                         projection: projection, tariffs: tariffs, timeZone: zone) {
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
        let alternative = scored
            .filter { $0.start != now }
            .min(by: { $0.cost == $1.cost ? $0.start < $1.start : $0.cost < $1.cost })
        let rawAlternative = alternative.map { nowCandidate.cost - $0.cost } ?? 0
        guard rawAlternative.isFinite else { return unavailable(.invalidInput) }
        let bestAlternativeSavings = max(0, rawAlternative)
        let minorUnit = currencyMinorUnit(currencyCode)
        let recommendation = savings > minorUnit ? best : nowCandidate
        return Result(comparison: Comparison(
            costNow: nowCandidate.cost,
            recommendedStart: recommendation.start,
            recommendedEnd: recommendation.end,
            recommendedCost: recommendation.cost,
            savings: recommendation.start == nowCandidate.start ? 0 : savings,
            bestAlternativeSavings: bestAlternativeSavings,
            estimatedSolarContribution: recommendation.solarContribution,
            horizonStart: now,
            horizonEnd: horizonEnd,
            evaluatedStarts: scored.map(\.start).sorted(),
            assumptions: assumptions(for: projection),
            hasUnobservedBalance: hasUnobservedBalance
        ), unavailableReason: nil)
    }

    private static func assumptions(for projection: Projection) -> [String] {
        let baseline: [String]
        switch projection {
        case .forecast:
            baseline = [
                "Typical household and battery behavior follows the historical local-time profile.",
                "Battery behavior is assumed unchanged by this added load."
            ]
        case .flat:
            baseline = ["Balances are held at today's observed values; no solar or household use is projected."]
        }
        return baseline + [
            "Recommendation is the best among evaluated start times, not a continuous-time optimum.",
            "Estimated cost uses the current signed period balances through the shared horizon."
        ]
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

    private static func completeCoverage(from start: Date, to end: Date, projection: Projection,
                                         tariffs: [LoadTimingTariffSegment], timeZone: TimeZone) -> Bool {
        guard start < end else { return false }
        let points = integrationBoundaries(from: start, to: end, projection: projection, tariffs: tariffs, timeZone: timeZone)
        guard points.count >= 2 else { return false }
        for index in 0..<(points.count - 1) {
            let a = points[index]
            let b = points[index + 1]
            guard b > a else { return false }
            let midpoint = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
            if case .forecast(let forecast, _) = projection,
               !forecast.contains(where: { $0.periodStart <= midpoint && midpoint < $0.periodEnd }) { return false }
            guard tariffs.contains(where: { $0.start <= midpoint && midpoint < $0.end }) else { return false }
        }
        return points.first == start && points.last == end
    }

    private static func firstContextGap(from start: Date, to end: Date, projection: Projection,
                                        tariffs: [LoadTimingTariffSegment], timeZone: TimeZone) -> Date? {
        guard case .forecast(_, let context) = projection else { return nil }
        guard start < end else { return start }
        let points = integrationBoundaries(from: start, to: end, projection: projection, tariffs: tariffs, timeZone: timeZone)
        guard points.count >= 2 else { return start }
        for index in 0..<(points.count - 1) {
            let midpoint = points[index].addingTimeInterval(points[index + 1].timeIntervalSince(points[index]) / 2)
            guard slot(at: midpoint, context: context, timeZone: timeZone) != nil else { return points[index] }
        }
        return nil
    }

    private static func integrationBoundaries(from start: Date, to end: Date, projection: Projection,
                                              tariffs: [LoadTimingTariffSegment], timeZone: TimeZone) -> [Date] {
        var values: Set<Date> = [start, end]
        for interval in projection.intervals {
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

    /// `nil` when the forecast or household profile doesn't cover `date`. `.flat` never moves.
    private static func flow(at date: Date, projection: Projection, timeZone: TimeZone) -> Flow? {
        switch projection {
        case .flat:
            return Flow(netExportKw: 0, physicalSurplusKw: 0)
        case .forecast(let forecast, let context):
            guard let solar = forecast.first(where: { $0.periodStart <= date && date < $0.periodEnd })?.powerKw,
                  let profile = slot(at: date, context: context, timeZone: timeZone),
                  let home = profile.homeKw, let battery = profile.batteryNetChargeKw else { return nil }
            return Flow(netExportKw: solar - home - battery, physicalSurplusKw: solar - home - max(battery, 0))
        }
    }

    private static func integrateBaseline(from start: Date, to end: Date, balances: [String: Double],
                                          projection: Projection, tariffs: [LoadTimingTariffSegment],
                                          timeZone: TimeZone) -> BaselineResult {
        var result = balances
        let points = integrationBoundaries(from: start, to: end, projection: projection, tariffs: tariffs, timeZone: timeZone)
        guard points.count >= 2 else { return .incompleteCoverage }
        for index in 0..<(points.count - 1) {
            let a = points[index], b = points[index + 1]
            let mid = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
            guard let flow = flow(at: mid, projection: projection, timeZone: timeZone),
                  let tariff = tariffs.first(where: { $0.start <= mid && mid < $0.end }),
                  let old = result[tariff.periodKey] else { return .incompleteCoverage }
            let seconds = b.timeIntervalSince(a)
            let hours = seconds / 3600
            let netPower = flow.netExportKw
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
                              projection: Projection, tariffs: [LoadTimingTariffSegment],
                              timeZone: TimeZone) -> ScoreResult {
        var withLoad = baseBalances
        var solarContribution = 0.0
        let points = integrationBoundaries(from: start, to: end, projection: projection, tariffs: tariffs, timeZone: timeZone)
        guard points.count >= 2 else { return .incompleteCoverage }
        let powerKw = load.energy / (load.duration / 3600)
        guard powerKw.isFinite, powerKw > 0 else { return .invalidInput }
        for index in 0..<(points.count - 1) {
            let a = points[index], b = points[index + 1]
            let mid = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
            guard let flow = flow(at: mid, projection: projection, timeZone: timeZone),
                  let tariff = tariffs.first(where: { $0.start <= mid && mid < $0.end }),
                  let balance = withLoad[tariff.periodKey] else { return .incompleteCoverage }
            let seconds = b.timeIntervalSince(a)
            let hours = seconds / 3600
            let energy = powerKw * hours
            let loadedBalance = balance - energy
            let physicalSurplus = flow.physicalSurplusKw
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
                                        projection: Projection, tariffs: [LoadTimingTariffSegment],
                                        timeZone: TimeZone) -> [Date] {
        var starts: Set<Date> = [now]
        for interval in projection.intervals {
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
