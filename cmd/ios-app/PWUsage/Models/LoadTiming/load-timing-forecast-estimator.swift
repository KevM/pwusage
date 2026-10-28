import Foundation

/// Compares one load against a signed billing-cycle balance using a device-local
/// solar forecast and the site's historical local-time household/battery profile.
struct LoadTimingForecastEstimator {
    static let maximumBalanceAge: TimeInterval = 30 * 60
    /// The forecast-free comparison uses a one-hour balance freshness window.
    static let maximumFlatBalanceAge: TimeInterval = 60 * 60
    /// Each `EnergyData` row holds signed energy for a five-minute interval and
    /// its timestamp marks that interval's start, so the cycle balance already
    /// includes the interval beginning at `balanceSourceTime`. Projecting the
    /// baseline from that same timestamp would count the latest interval twice.
    static let observedIntervalDuration: TimeInterval = 5 * 60
    /// How far ahead the Solcast forecast drives the projection; site history takes over after it.
    static let forecastWindow: TimeInterval = 7 * 86_400
    /// How far below zero a cloudy week may leave a bank a start dips into.
    static let safetyShortfallKwh = 3.0
    /// How far each forecast interval moves from `pv_estimate` toward `pv_estimate10`
    /// in the cautious run, so the safety window as a whole is a 1-in-4 week rather
    /// than seven 1-in-10 days in a row. The weekly 25th percentile falls short of
    /// the median by z(0.25)·σ·√7, the daily 10th percentile by z(0.10)·σ, so each
    /// interval moves (0.6745 / 1.2816) / √7 ≈ 20% of the way (days taken as independent).
    static let forecastCautiousWeight = (0.6745 / 1.2816) / 7.0.squareRoot()

    /// Whether the cautious projection lets the starts dip into banks.
    enum Safety: Codable, Equatable {
        /// Starting now passes (and so does the recommendation).
        case nowSafe
        /// Starting now would leave this bank short; a later start passes and may cost more than now.
        case nowUnsafe(periodKey: String)
        /// No start passes; the recommendation leaves this bank least short.
        case noSafeStart(periodKey: String)
    }

    /// The cheapest start the safety rule rejected, when it is cheaper than the recommendation.
    struct RuledOut: Codable, Equatable {
        let start: Date
        let cost: Double
        /// The bank a cloudy week would leave more than `safetyShortfallKwh` short.
        let periodKey: String
    }

    enum UnavailableReason: String, Codable, Equatable {
        case invalidInput
        case missingTariff
        case incompleteBalance
        case staleBalance
        case incompleteCoverage
        case incompleteContext
        case noFittingRun
        case noEnergyNeeded
    }

    struct PlanningSlot: Codable, Equatable {
        let localMinute: Int
        let homeKw: Double?
        let batteryNetChargeKw: Double?
        /// Typical grid net export from the site's history (export positive).
        var gridNetExportKw: Double? = nil
        /// The cautious ("dull day") grid net export from the site's history.
        var cautiousGridNetExportKw: Double? = nil
    }

    struct PlanningContext: Codable, Equatable {
        let timeZone: String
        let slots: [PlanningSlot]
        let asOf: Date

        /// The server sent grid history (an older server sends none).
        var hasGridHistory: Bool { slots.contains { $0.gridNetExportKw != nil } }
    }

    /// How balances move between now and the end of the projection.
    /// `.forecast` projects solar and typical household use for up to
    /// `forecastWindow`, then the site's grid history when the context carries
    /// it; without history it ends with the forecast, as before the projection
    /// reached the bill date. `.history` projects the site's grid history from
    /// now. `.flat` holds each period's balance at today's observed value, so
    /// only the job moves it.
    static func periodSwitches(in tariffs: [LoadTimingTariffSegment], after now: Date, before end: Date) -> [Date] {
        zip(tariffs, tariffs.dropFirst()).compactMap { previous, next in
            next.periodKey != previous.periodKey && next.start > now && next.start < end ? next.start : nil
        }
    }

    static let safetyAssumption = "A start that dips into a bank must leave it no more than 3 kWh short after a cloudy week."

    static func assumptions(for projection: Projection) -> [String] {
        let baseline: [String]
        switch projection {
        case .forecast(_, let context):
            baseline = [
                "Typical household and battery behavior follows the historical local-time profile.",
                "Battery behavior is assumed unchanged by this added load.",
            ] + (context.hasGridHistory
                ? ["Solar follows your Solcast forecast for the next 7 days, then your last four weeks through the bill date.",
                   safetyAssumption]
                : [])
        case .history:
            baseline = ["Banks follow your last four weeks of grid use through the bill date.", safetyAssumption]
        case .flat:
            baseline = ["Banks are held at today's observed values; no solar or household use is projected."]
        }
        return baseline + [
            "Recommendation is the best among evaluated start times, not a continuous-time optimum.",
            "Estimated cost uses each period's current bank through the shared horizon.",
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

    static func unavailable(_ reason: UnavailableReason) -> Result {
        Result(comparison: nil, unavailableReason: reason)
    }

    static func loadShape(for profile: LoadProfile) -> (energy: Double, duration: TimeInterval)? {
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

    static func validatedLoadShape(energy: Double, durationHours: Double) -> (energy: Double, duration: TimeInterval)? {
        let duration = durationHours * 3600
        let powerKw = energy / durationHours
        guard energy.isFinite, energy > 0, durationHours.isFinite, durationHours > 0,
              duration.isFinite, duration > 0, powerKw.isFinite, powerKw > 0 else { return nil }
        return (energy, duration)
    }

    static func validTariffIntervals(_ tariffs: [LoadTimingTariffSegment]) -> Bool {
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

    static func validForecast(_ forecast: [SolarForecastInterval]) -> Bool {
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

    static func supportedRates(in tariffs: [LoadTimingTariffSegment], from source: Date, before horizonEnd: Date)
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

    static func contiguousEnd(of forecast: [SolarForecastInterval], startingAt source: Date) -> Date {
        let intervals = forecast.sorted { $0.periodStart < $1.periodStart }
        guard let first = intervals.first(where: { $0.periodStart <= source && $0.periodEnd > source }) else { return source }
        var end = first.periodEnd
        for interval in intervals where interval.periodStart >= end {
            guard interval.periodStart == end else { break }
            end = interval.periodEnd
        }
        return end
    }

    /// The run of back-to-back forecast intervals that contains `date`, if any.
    static func contiguousBlock(of forecast: [SolarForecastInterval], containing date: Date) -> (start: Date, end: Date)? {
        let intervals = forecast.sorted { $0.periodStart < $1.periodStart }
        guard var index = intervals.firstIndex(where: { $0.periodStart <= date && $0.periodEnd > date }) else { return nil }
        while index > 0, intervals[index - 1].periodEnd == intervals[index].periodStart { index -= 1 }
        return (intervals[index].periodStart, contiguousEnd(of: forecast, startingAt: date))
    }

    static func contiguousTariffEnd(_ tariffs: [LoadTimingTariffSegment], startingAt source: Date) -> Date {
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

    static func endOfTomorrow(after date: Date, timeZone: TimeZone) -> Date? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let startOfToday = calendar.dateInterval(of: .day, for: date)?.start else { return nil }
        return calendar.date(byAdding: .day, value: 2, to: startOfToday)
    }

    static func firstContextGap(from start: Date, to end: Date, model: FlowModel,
                                tariffs: [LoadTimingTariffSegment]) -> Date? {
        guard model.projection.projectsFlow else { return nil }
        guard start < end else { return start }
        let points = integrationBoundaries(from: start, to: end, model: model, tariffs: tariffs)
        guard points.count >= 2 else { return start }
        for index in 0 ..< (points.count - 1) {
            let midpoint = points[index].addingTimeInterval(points[index + 1].timeIntervalSince(points[index]) / 2)
            guard model.hasContext(at: midpoint) else { return points[index] }
        }
        return nil
    }

    static func integrationBoundaries(from start: Date, to end: Date, model: FlowModel,
                                      tariffs: [LoadTimingTariffSegment]) -> [Date] {
        model.boundaries(from: start, to: end)
    }

    static func score(start: Date, end: Date, load: (energy: Double, duration: TimeInterval),
                      baseBalances: [String: Double], rates: [String: PeriodRate],
                      steps: Steps, safetyEnd: Date) -> ScoreResult {
        var withLoad = baseBalances
        var drawsBySafetyEnd: [String: Double] = [:]
        var solarContribution = 0.0
        guard start < end, var index = steps.step(containing: start), end <= steps.edges[steps.edges.count - 1] else {
            return .incompleteCoverage
        }
        let powerKw = load.energy / (load.duration / 3600)
        guard powerKw.isFinite, powerKw > 0 else { return .invalidInput }
        while index < steps.periods.count, steps.edges[index] < end {
            defer { index += 1 }
            let a = max(steps.edges[index], start), b = min(steps.edges[index + 1], end)
            let flow = steps.typical[index]
            let periodKey = steps.periods[index]
            guard let balance = withLoad[periodKey] else { return .incompleteCoverage }
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
            withLoad[periodKey] = loadedBalance
            // A step straddling the cutoff counts only its part before it.
            if a < safetyEnd {
                drawsBySafetyEnd[periodKey, default: 0] += b <= safetyEnd ? energy : powerKw * safetyEnd.timeIntervalSince(a) / 3600
            }
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
        var draws: [String: Double] = [:]
        for (key, loadedBalance) in withLoad {
            if let base = baseBalances[key], loadedBalance != base { draws[key] = base - loadedBalance }
        }
        return .candidate(Candidate(start: start, end: end, cost: total,
                                    solarContribution: cappedSolarContribution, draws: draws,
                                    drawsBySafetyEnd: drawsBySafetyEnd))
    }

    static func cost(balance: Double, rate: PeriodRate) -> Double? {
        let importCost = max(-balance, 0) * rate.buy
        let exportCredit = max(balance, 0) * rate.sell
        let total = importCost - exportCredit
        guard importCost.isFinite, exportCredit.isFinite, total.isFinite else { return nil }
        return total
    }

    static func candidateStarts(now: Date, horizonEnd: Date, duration: TimeInterval,
                                model: FlowModel, tariffs: [LoadTimingTariffSegment]) -> [Date] {
        var starts: Set<Date> = [now]
        for interval in model.intervals {
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
        starts.formUnion(model.clock.halfHours(after: now, before: horizonEnd))
        return starts.sorted()
    }
}
