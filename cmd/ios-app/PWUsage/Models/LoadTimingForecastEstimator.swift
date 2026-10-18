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
    /// How far ahead the Solcast forecast drives the projection; site history takes over after it.
    static let forecastWindow: TimeInterval = 7 * 86_400
    /// How far below zero a cloudy week may leave a bank a start dips into.
    static let safetyShortfallKwh = 3.0

    /// Whether the cautious projection lets the starts dip into banks.
    enum Safety: Equatable {
        /// Starting now passes (and so does the recommendation).
        case nowSafe
        /// Starting now would leave this bank short; a later start passes and may cost more than now.
        case nowUnsafe(periodKey: String)
        /// No start passes; the recommendation leaves this bank least short.
        case noSafeStart(periodKey: String)
    }

    /// The cheapest start the safety rule rejected, when it is cheaper than the recommendation.
    struct RuledOut: Equatable {
        let start: Date
        let cost: Double
        /// The bank a cloudy week would leave more than `safetyShortfallKwh` short.
        let periodKey: String
    }

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
        /// Typical grid net export from the site's history (export positive).
        var gridNetExportKw: Double? = nil
        /// The cautious ("dull day") grid net export from the site's history.
        var cautiousGridNetExportKw: Double? = nil
    }

    struct PlanningContext: Equatable {
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
    enum Projection: Equatable {
        case forecast(intervals: [SolarForecastInterval], context: PlanningContext)
        case history(context: PlanningContext)
        case flat(timeZone: String)

        var timeZone: String {
            switch self {
            case .forecast(_, let context), .history(let context): context.timeZone
            case .flat(let timeZone): timeZone
            }
        }

        var maximumBalanceAge: TimeInterval {
            switch self {
            case .forecast: LoadTimingForecastEstimator.maximumBalanceAge
            // Like `.flat`, the forecast-free card follows `LoadTimingRecommendation`'s window.
            case .history, .flat: LoadTimingForecastEstimator.maximumFlatBalanceAge
            }
        }

        /// Solar intervals whose edges are integration and candidate boundaries; none without a forecast.
        var intervals: [SolarForecastInterval] {
            switch self {
            case .forecast(let intervals, _): intervals
            case .history, .flat: []
            }
        }

        var context: PlanningContext? {
            switch self {
            case .forecast(_, let context), .history(let context): context
            case .flat: nil
            }
        }

        /// Balances move with projected household flow, so every period needs an observed balance.
        var projectsFlow: Bool { context != nil }
    }

    struct BalancePoint: Equatable {
        let date: Date
        let kwh: Double
    }

    /// One rate period's signed balance from `now` to the horizon end, for the
    /// run starting now and for the recommended run, each on top of the baseline.
    struct BalanceLane: Equatable {
        let periodKey: String
        /// The projected balance at `now`.
        let startKwh: Double
        let recommended: [BalancePoint]
        let startNow: [BalancePoint]
        /// The typical projection at `projectionEnd` without either run.
        let projectedKwh: Double
        /// The typical projection at `projectionEnd` after the recommended run.
        let projectedAfterRecommendedKwh: Double
        /// The typical projection at `projectionEnd` after starting now.
        let projectedAfterStartNowKwh: Double

        /// The projection defaults describe one that ends at the chart edge.
        init(periodKey: String, startKwh: Double, recommended: [BalancePoint], startNow: [BalancePoint],
             projectedKwh: Double? = nil, projectedAfterRecommendedKwh: Double? = nil,
             projectedAfterStartNowKwh: Double? = nil) {
            self.periodKey = periodKey
            self.startKwh = startKwh
            self.recommended = recommended
            self.startNow = startNow
            self.projectedKwh = projectedKwh ?? startKwh
            self.projectedAfterRecommendedKwh = projectedAfterRecommendedKwh ?? recommended.last?.kwh ?? startKwh
            self.projectedAfterStartNowKwh = projectedAfterStartNowKwh ?? startNow.last?.kwh ?? startKwh
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
        /// Periods either run touches plus the period in effect now (every period in
        /// the horizon when starting now wins), ordered by first occurrence from now.
        let lanes: [BalanceLane]
        /// Tariff period changes strictly inside (now, horizonEnd).
        let periodSwitches: [Date]
        /// Where every start is priced: the bill date, unless a rate change, a
        /// period with no balance, or the end of tariff, forecast or history
        /// coverage comes first. `horizonEnd` (the search and chart window) never
        /// passes it; a run may finish after `horizonEnd` but not after this.
        let projectionEnd: Date
        /// The projection ended at a rate change or a period with no balance, before the bill date.
        let projectionEndsAtRateChange: Bool
        /// Where the safety rule reads the cautious projection: min(now + forecastWindow, projectionEnd).
        let safetyEnd: Date
        let safety: Safety
        let ruledOut: RuledOut?

        init(costNow: Double, recommendedStart: Date, recommendedEnd: Date, recommendedCost: Double, savings: Double,
             bestAlternativeSavings: Double, estimatedSolarContribution: Double, horizonStart: Date, horizonEnd: Date,
             evaluatedStarts: [Date], assumptions: [String], hasUnobservedBalance: Bool, lanes: [BalanceLane],
             periodSwitches: [Date], projectionEnd: Date? = nil, projectionEndsAtRateChange: Bool = false,
             safetyEnd: Date? = nil, safety: Safety = .nowSafe, ruledOut: RuledOut? = nil) {
            self.costNow = costNow
            self.recommendedStart = recommendedStart
            self.recommendedEnd = recommendedEnd
            self.recommendedCost = recommendedCost
            self.savings = savings
            self.bestAlternativeSavings = bestAlternativeSavings
            self.estimatedSolarContribution = estimatedSolarContribution
            self.horizonStart = horizonStart
            self.horizonEnd = horizonEnd
            self.evaluatedStarts = evaluatedStarts
            self.assumptions = assumptions
            self.hasUnobservedBalance = hasUnobservedBalance
            self.lanes = lanes
            self.periodSwitches = periodSwitches
            self.projectionEnd = projectionEnd ?? horizonEnd
            self.projectionEndsAtRateChange = projectionEndsAtRateChange
            self.safetyEnd = safetyEnd ?? projectionEnd ?? horizonEnd
            self.safety = safety
            self.ruledOut = ruledOut
        }
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
        /// kWh the run takes from each period's balance.
        let draws: [String: Double]
        /// The part of `draws` taken before the safety window ends.
        let drawsBySafetyEnd: [String: Double]
    }

    /// A candidate read against the cautious projection at the safety window's end.
    private struct Assessment {
        let candidate: Candidate
        /// The lowest cautious balance among the banks the run dips into, and that bank.
        let worst: (periodKey: String, kwh: Double)?

        var passes: Bool { (worst?.kwh ?? 0) >= -LoadTimingForecastEstimator.safetyShortfallKwh - 1e-9 }
        var shortfall: Double { max(0, -(worst?.kwh ?? 0)) }
    }

    private enum BaselineResult {
        case balances([String: Double])
        case invalidInput
        case incompleteCoverage
    }

    /// The site's time zone and its local half-hour boundaries across the whole
    /// search. Integration and candidate starts both need those boundaries, and
    /// re-scanning them minute by minute for every candidate run dominated the
    /// cost of an evaluation, so they are scanned once.
    private struct WallClock {
        /// Gregorian, in the site's time zone; built once because slot lookups run per interval.
        let calendar: Calendar
        private let halfHourBoundaries: [Date]

        init(timeZone: TimeZone, from start: Date, to end: Date) {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            self.calendar = calendar
            // Scan minute boundaries so non-hour offsets and DST transitions are honored.
            var boundaries: [Date] = []
            var cursor = Date(timeIntervalSince1970: floor(start.timeIntervalSince1970 / 60) * 60 + 60)
            while cursor < end {
                if calendar.component(.minute, from: cursor).isMultiple(of: 30),
                   calendar.component(.second, from: cursor) == 0 {
                    boundaries.append(cursor)
                }
                cursor = cursor.addingTimeInterval(60)
            }
            halfHourBoundaries = boundaries
        }

        /// Local half-hour boundaries strictly between `start` and `end`.
        func halfHours(after start: Date, before end: Date) -> ArraySlice<Date> {
            let lower = halfHourBoundaries.partitionPoint { $0 > start }
            let upper = halfHourBoundaries.partitionPoint { $0 >= end }
            return lower < upper ? halfHourBoundaries[lower..<upper] : []
        }
    }

    /// Household flow at one instant: what the baseline exports to the grid, and the
    /// solar left over after the home and any battery charging, which an added load can use.
    private struct Flow {
        let netExportKw: Double
        let physicalSurplusKw: Double
    }

    /// Where the household flow at an instant comes from: the solar forecast
    /// with the household pattern before `forecastEnd`, the site's grid history
    /// after it (and throughout `.history`), or nothing for `.flat`.
    private struct FlowModel {
        let projection: Projection
        let clock: WallClock
        let forecastEnd: Date
        /// Use `pv_estimate10` and the 1-in-4 dull day instead of the medians.
        let cautious: Bool
        /// Forecast intervals that drive the flow (those starting before `forecastEnd`).
        let intervals: [SolarForecastInterval]
        private let slots: [Int: PlanningSlot]

        init(projection: Projection, clock: WallClock, forecastEnd: Date, cautious: Bool = false) {
            self.projection = projection
            self.clock = clock
            self.forecastEnd = forecastEnd
            self.cautious = cautious
            intervals = projection.intervals.filter { $0.periodStart < forecastEnd }
            // A slot is usable only when its minute appears exactly once.
            let grouped = Dictionary(grouping: projection.context?.slots ?? [], by: \.localMinute)
            slots = grouped.compactMapValues { matches in
                guard matches.count == 1, let match = matches.first, match.localMinute >= 0,
                      match.localMinute < 1440, match.localMinute.isMultiple(of: 30) else { return nil }
                return match
            }
        }

        func cautiousModel() -> FlowModel {
            FlowModel(projection: projection, clock: clock, forecastEnd: forecastEnd, cautious: true)
        }

        private func slot(at date: Date) -> PlanningSlot? {
            let calendar = clock.calendar
            let localMinute = calendar.component(.hour, from: date) * 60 + calendar.component(.minute, from: date)
            return slots[(localMinute / 30) * 30]
        }

        private func usesForecast(at date: Date) -> Bool {
            if case .forecast = projection { return date < forecastEnd }
            return false
        }

        /// The household pattern (forecast window) or the grid history covers `date`.
        func hasContext(at date: Date) -> Bool {
            guard projection.projectsFlow else { return true }
            guard let slot = slot(at: date) else { return false }
            if usesForecast(at: date) {
                guard let home = slot.homeKw, let battery = slot.batteryNetChargeKw else { return false }
                return home.isFinite && battery.isFinite
            }
            return slot.gridNetExportKw?.isFinite ?? false
        }

        /// A forecast interval covers `date`, or `date` is outside the forecast window.
        func hasForecast(at date: Date) -> Bool {
            guard usesForecast(at: date) else { return true }
            return intervals.contains { $0.periodStart <= date && date < $0.periodEnd }
        }

        /// `nil` when the forecast, household pattern or history doesn't cover `date`. `.flat` never moves.
        func flow(at date: Date) -> Flow? {
            guard projection.projectsFlow else { return Flow(netExportKw: 0, physicalSurplusKw: 0) }
            guard let slot = slot(at: date) else { return nil }
            if usesForecast(at: date) {
                guard let interval = intervals.first(where: { $0.periodStart <= date && date < $0.periodEnd }),
                      let home = slot.homeKw, let battery = slot.batteryNetChargeKw,
                      home.isFinite, battery.isFinite else { return nil }
                let solar = cautious ? (interval.cautiousPowerKw ?? interval.powerKw) : interval.powerKw
                return Flow(netExportKw: solar - home - battery, physicalSurplusKw: solar - home - max(battery, 0))
            }
            let typical = slot.gridNetExportKw
            guard let grid = cautious ? (slot.cautiousGridNetExportKw ?? typical) : typical, grid.isFinite else { return nil }
            // History records only what reached the grid; that export is what an added load could use.
            return Flow(netExportKw: grid, physicalSurplusKw: grid)
        }
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
        if let context = projection.context, !context.asOf.timeIntervalSince1970.isFinite {
            return unavailable(.invalidInput)
        }
        guard now.timeIntervalSince(balanceSourceTime) <= projection.maximumBalanceAge else { return unavailable(.staleBalance) }
        guard timing.hasTariff, !timing.tariffTimeline.isEmpty else { return unavailable(.missingTariff) }
        if projection.projectsFlow, !timing.hasCycleData { return unavailable(.incompleteBalance) }
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

        // Two horizons: starts are searched (and charted) to midnight tomorrow,
        // while balances are projected to the bill date so each start is priced
        // by what it does to the bill.
        let tomorrowEnd = endOfTomorrow(after: now, timeZone: zone)
        guard let tomorrowEnd, tomorrowEnd > now else { return unavailable(.invalidInput) }
        var projectionEnd = billingCycleEnd
        var endsAtRateChange = false
        var forecastEnd = projectionStart
        if case .forecast(let forecast, let context) = projection {
            let coverageEnd = contiguousEnd(of: forecast, startingAt: projectionStart)
            if context.hasGridHistory {
                // History fills in after the forecast window, or where the forecast falls short of it.
                forecastEnd = min(coverageEnd, now.addingTimeInterval(Self.forecastWindow))
            } else {
                // Without history there is nothing to project past the forecast, and
                // an older server's context keeps today's horizon exactly.
                forecastEnd = coverageEnd
                projectionEnd = min(projectionEnd, coverageEnd, tomorrowEnd)
            }
        }
        projectionEnd = min(projectionEnd, contiguousTariffEnd(tariffs, startingAt: projectionStart))
        guard projectionEnd > now else { return unavailable(.incompleteCoverage) }
        let clock = WallClock(timeZone: zone, from: projectionStart, to: projectionEnd)
        let model = FlowModel(projection: projection, clock: clock, forecastEnd: forecastEnd)

        // A rate change for one billing-period balance ends the shared projection.
        // Rates outside the projection do not participate in validation.
        let rateSet = supportedRates(in: tariffs, from: balanceSourceTime, before: projectionEnd)
        guard !rateSet.invalid else { return unavailable(.invalidInput) }
        if let boundary = rateSet.incompatibleBoundary, boundary < projectionEnd {
            projectionEnd = boundary
            endsAtRateChange = true
        }
        guard projectionEnd > now else { return unavailable(.incompleteCoverage) }

        if let contextGap = firstContextGap(from: projectionStart, to: projectionEnd, model: model, tariffs: tariffs),
           contextGap < projectionEnd {
            projectionEnd = contextGap
            endsAtRateChange = false
            guard projectionEnd > now else { return unavailable(.incompleteContext) }
        }

        let finalRateSet = supportedRates(in: tariffs, from: balanceSourceTime, before: projectionEnd)
        guard !finalRateSet.invalid else { return unavailable(.invalidInput) }
        var rates = finalRateSet.rates

        // Like `LoadTimingRecommendation`, the forecast-free path reads no balances
        // when the cycle has no data yet, so every period is priced from zero.
        let observedBalances: [String: Double] = timing.hasCycleData
            ? Dictionary(timing.pricingPeriods.map { ($0.name, $0.cycleNetExportKwh) }, uniquingKeysWith: { _, latest in latest })
            : [:]

        var balances: [String: Double] = [:]
        var hasUnobservedBalance = false
        if projection.projectsFlow {
            // A tariff period with no observed balance cannot be projected. If it has
            // not started yet — a seasonal schedule boundary, for example — end the
            // shared projection there instead of discarding the whole comparison. If
            // it is already under way the baseline is unsound, so reject.
            if let firstUnbalanced = rates.keys.compactMap({ key -> Date? in
                guard observedBalances[key] == nil else { return nil }
                return tariffs.first(where: { $0.periodKey == key && $0.start < projectionEnd })?.start
            }).min() {
                guard firstUnbalanced > now else { return unavailable(.incompleteBalance) }
                if firstUnbalanced < projectionEnd {
                    projectionEnd = firstUnbalanced
                    endsAtRateChange = true
                }
                guard projectionEnd > now else { return unavailable(.incompleteCoverage) }
                let truncated = supportedRates(in: tariffs, from: balanceSourceTime, before: projectionEnd)
                guard !truncated.invalid else { return unavailable(.invalidInput) }
                rates = truncated.rates
            }
            for key in rates.keys {
                guard let balance = observedBalances[key] else { return unavailable(.incompleteBalance) }
                guard balance.isFinite else { return unavailable(.incompleteBalance) }
                balances[key] = balance
            }
        } else {
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
        let horizonEnd = min(tomorrowEnd, projectionEnd)

        // Forecast/context/tariff coverage from the end of observed data through
        // the projection is needed even when a candidate run starts later.
        guard completeCoverage(from: projectionStart, to: projectionEnd, model: model, tariffs: tariffs) else {
            return unavailable(.incompleteCoverage)
        }

        let baseBalances: [String: Double]
        switch integrateBaseline(from: projectionStart, to: projectionEnd, balances: balances,
                                 model: model, tariffs: tariffs) {
        case .balances(let projected): baseBalances = projected
        case .invalidInput: return unavailable(.invalidInput)
        case .incompleteCoverage: return unavailable(.incompleteCoverage)
        }
        // The cautious run (pv_estimate10, then the dull day) is read only at the
        // safety window's end: history beyond it never makes a start pass.
        let safetyEnd = min(now.addingTimeInterval(Self.forecastWindow), projectionEnd)
        let cautiousBalances: [String: Double]
        switch integrateBaseline(from: projectionStart, to: safetyEnd, balances: balances,
                                 model: model.cautiousModel(), tariffs: tariffs) {
        case .balances(let projected): cautiousBalances = projected
        case .invalidInput: return unavailable(.invalidInput)
        case .incompleteCoverage: return unavailable(.incompleteCoverage)
        }
        let candidates = candidateStarts(now: now, horizonEnd: horizonEnd, duration: load.duration,
                                        model: model, tariffs: tariffs)
        var scored: [Candidate] = []
        for candidateStart in candidates {
            let candidateEnd = candidateStart.addingTimeInterval(load.duration)
            guard candidateStart >= now, candidateStart < horizonEnd else { continue }
            guard candidateEnd.timeIntervalSince1970.isFinite else { return unavailable(.invalidInput) }
            // A run starts inside the search window but may finish after it, up to the projection end.
            guard candidateEnd <= projectionEnd else { continue }
            switch score(start: candidateStart, end: candidateEnd, load: load,
                         baseBalances: baseBalances, rates: rates, model: model, tariffs: tariffs,
                         safetyEnd: safetyEnd) {
            case .candidate(let candidate): scored.append(candidate)
            case .invalidInput: return unavailable(.invalidInput)
            case .incompleteCoverage: return unavailable(.incompleteCoverage)
            }
        }
        guard let nowCandidate = scored.first(where: { $0.start == now }) else { return unavailable(.noFittingRun) }
        guard scored.allSatisfy({ $0.cost.isFinite }) else { return unavailable(.invalidInput) }
        let minorUnit = currencyMinorUnit(currencyCode)
        let selection = select(scored.map { assess($0, baseBalances: baseBalances, cautiousBalances: cautiousBalances) },
                               now: now, minorUnit: minorUnit)
        let recommendation = selection.recommendation
        let savings = recommendation.start == nowCandidate.start ? 0 : max(0, nowCandidate.cost - recommendation.cost)
        guard let lanes = balanceLanes(now: now, horizonEnd: horizonEnd, projectionStart: projectionStart,
                                       balances: balances, baseBalances: baseBalances, load: load,
                                       startNow: nowCandidate, recommended: recommendation,
                                       model: model, tariffs: tariffs) else {
            return unavailable(.invalidInput)
        }
        return Result(comparison: Comparison(
            costNow: nowCandidate.cost,
            recommendedStart: recommendation.start,
            recommendedEnd: recommendation.end,
            recommendedCost: recommendation.cost,
            savings: savings,
            bestAlternativeSavings: selection.bestAlternativeSavings,
            estimatedSolarContribution: recommendation.solarContribution,
            horizonStart: now,
            horizonEnd: horizonEnd,
            evaluatedStarts: scored.map(\.start).sorted(),
            assumptions: assumptions(for: projection),
            hasUnobservedBalance: hasUnobservedBalance,
            lanes: lanes,
            periodSwitches: periodSwitches(in: tariffs, after: now, before: horizonEnd),
            projectionEnd: projectionEnd,
            projectionEndsAtRateChange: endsAtRateChange,
            safetyEnd: safetyEnd,
            safety: selection.safety,
            ruledOut: selection.ruledOut
        ), unavailableReason: nil)
    }

    /// A run "dips into" a bank when the typical projection prices some of it at
    /// that period's sell rate: the bank ends the projection banked and the run
    /// draws on it. Each such bank is read in the cautious projection at the
    /// safety window's end, less the run's draw before then.
    private static func assess(_ candidate: Candidate, baseBalances: [String: Double],
                               cautiousBalances: [String: Double]) -> Assessment {
        var worst: (periodKey: String, kwh: Double)?
        for (key, draw) in candidate.draws.sorted(by: { $0.key < $1.key }) where draw > 0 {
            guard let typical = baseBalances[key], typical > 0, let cautious = cautiousBalances[key] else { continue }
            let remaining = cautious - (candidate.drawsBySafetyEnd[key] ?? 0)
            if worst == nil || remaining < worst!.kwh { worst = (key, remaining) }
        }
        return Assessment(candidate: candidate, worst: worst)
    }

    private struct Selection {
        let recommendation: Candidate
        let safety: Safety
        let ruledOut: RuledOut?
        let bestAlternativeSavings: Double
    }

    /// The cheapest start that passes the safety rule (ties: earliest); starting
    /// now unless a passing later start saves more than a minor unit while now
    /// passes too. When nothing passes, the start leaving its bank least short
    /// (ties: cheapest, then earliest).
    private static func select(_ assessed: [Assessment], now: Date, minorUnit: Double) -> Selection {
        func cheapest(_ pool: [Assessment]) -> Assessment? {
            pool.min { $0.candidate.cost == $1.candidate.cost ? $0.candidate.start < $1.candidate.start
                                                              : $0.candidate.cost < $1.candidate.cost }
        }
        // `evaluate` only calls this with a scored "now".
        let nowAssessment = assessed.first { $0.candidate.start == now }!
        let passing = assessed.filter(\.passes)
        let recommended: Assessment
        let safety: Safety
        if let best = cheapest(passing) {
            if nowAssessment.passes {
                recommended = nowAssessment.candidate.cost - best.candidate.cost > minorUnit ? best : nowAssessment
                safety = .nowSafe
            } else {
                recommended = best
                safety = .nowUnsafe(periodKey: nowAssessment.worst?.periodKey ?? "")
            }
        } else {
            let least = assessed.map(\.shortfall).min() ?? 0
            let pool = assessed.filter { $0.shortfall <= least + 1e-9 }
            let best = cheapest(pool) ?? nowAssessment
            let nowInPool = pool.contains { $0.candidate.start == now }
            recommended = nowInPool && nowAssessment.candidate.cost - best.candidate.cost <= minorUnit ? nowAssessment : best
            safety = .noSafeStart(periodKey: recommended.worst?.periodKey ?? "")
        }
        let rejectedCheaper = assessed.filter {
            !$0.passes && recommended.candidate.cost - $0.candidate.cost > minorUnit
        }
        let ruledOut = cheapest(rejectedCheaper).map {
            RuledOut(start: $0.candidate.start, cost: $0.candidate.cost, periodKey: $0.worst?.periodKey ?? "")
        }
        // Raw saving of the cheapest eligible non-now start, before the minor-unit threshold.
        let alternatives = (passing.isEmpty ? assessed : passing).filter { $0.candidate.start != now }
        let bestAlternativeSavings = cheapest(alternatives).map { max(0, nowAssessment.candidate.cost - $0.candidate.cost) } ?? 0
        return Selection(recommendation: recommended.candidate, safety: safety, ruledOut: ruledOut,
                         bestAlternativeSavings: bestAlternativeSavings)
    }

    private static func balanceLanes(now: Date, horizonEnd: Date, projectionStart: Date, balances: [String: Double],
                                     baseBalances: [String: Double], load: (energy: Double, duration: TimeInterval),
                                     startNow: Candidate, recommended: Candidate, model: FlowModel,
                                     tariffs: [LoadTimingTariffSegment]) -> [BalanceLane]? {
        let powerKw = load.energy / (load.duration / 3600)
        // The baseline from the end of observed data to now gives each lane's starting balance.
        var nowBalances = balances
        if projectionStart < now {
            guard case .balances(let projected) = integrateBaseline(from: projectionStart, to: now, balances: balances,
                                                                    model: model, tariffs: tariffs) else { return nil }
            nowBalances = projected
        }
        guard let nowSeries = balanceSeries(from: now, to: horizonEnd, balances: nowBalances,
                                            run: (startNow.start, startNow.end), powerKw: powerKw,
                                            model: model, tariffs: tariffs),
              let recommendedSeries = balanceSeries(from: now, to: horizonEnd, balances: nowBalances,
                                                    run: (recommended.start, recommended.end), powerKw: powerKw,
                                                    model: model, tariffs: tariffs)
        else { return nil }

        func periods(touching start: Date, _ end: Date) -> Set<String> {
            Set(tariffs.filter { $0.start < end && $0.end > start }.map(\.periodKey))
        }
        var keys = periods(touching: startNow.start, startNow.end).union(periods(touching: recommended.start, recommended.end))
        if let current = tariffs.first(where: { $0.start <= now && now < $0.end }) { keys.insert(current.periodKey) }
        // When starting now wins, every bank it was compared against keeps a (flat)
        // lane, so people can see the run doesn't draw on them.
        if recommended.start == startNow.start { keys.formUnion(periods(touching: now, horizonEnd)) }
        let firstOccurrence = Dictionary(tariffs.filter { $0.end > now && $0.start < horizonEnd }
            .map { ($0.periodKey, max($0.start, now)) }, uniquingKeysWith: min)

        return keys.filter { nowBalances[$0] != nil }
            .sorted { (firstOccurrence[$0] ?? .distantFuture, $0) < (firstOccurrence[$1] ?? .distantFuture, $1) }
            .compactMap { key in
                guard let start = nowBalances[key], let later = recommendedSeries[key], let immediate = nowSeries[key],
                      let projected = baseBalances[key] else {
                    return nil
                }
                return BalanceLane(periodKey: key, startKwh: start, recommended: later, startNow: immediate,
                                   projectedKwh: projected,
                                   projectedAfterRecommendedKwh: projected - (recommended.draws[key] ?? 0),
                                   projectedAfterStartNowKwh: projected - (startNow.draws[key] ?? 0))
            }
    }

    /// Integrates the baseline plus, inside `run`, the load's draw, recording every
    /// period's balance at each integration boundary. `nil` when a value overflows.
    private static func balanceSeries(from start: Date, to end: Date, balances: [String: Double],
                                      run: (start: Date, end: Date), powerKw: Double, model: FlowModel,
                                      tariffs: [LoadTimingTariffSegment]) -> [String: [BalancePoint]]? {
        var boundaries = Set(integrationBoundaries(from: start, to: end, model: model, tariffs: tariffs))
        for edge in [run.start, run.end] where edge > start && edge < end { boundaries.insert(edge) }
        let points = boundaries.sorted()
        guard points.count >= 2 else { return nil }
        var current = balances
        var series = current.mapValues { [BalancePoint(date: start, kwh: $0)] }
        for index in 0..<(points.count - 1) {
            let a = points[index], b = points[index + 1]
            let mid = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
            guard let flow = model.flow(at: mid),
                  let tariff = tariffs.first(where: { $0.start <= mid && mid < $0.end }),
                  let old = current[tariff.periodKey] else { return nil }
            let hours = b.timeIntervalSince(a) / 3600
            let draw = a >= run.start && b <= run.end ? powerKw * hours : 0
            let updated = old + flow.netExportKw * hours - draw
            guard updated.isFinite else { return nil }
            current[tariff.periodKey] = updated
            for (key, kwh) in current { series[key, default: []].append(BalancePoint(date: b, kwh: kwh)) }
        }
        return series
    }

    private static func periodSwitches(in tariffs: [LoadTimingTariffSegment], after now: Date, before end: Date) -> [Date] {
        zip(tariffs, tariffs.dropFirst()).compactMap { previous, next in
            next.periodKey != previous.periodKey && next.start > now && next.start < end ? next.start : nil
        }
    }

    private static func assumptions(for projection: Projection) -> [String] {
        let baseline: [String]
        switch projection {
        case .forecast:
            baseline = [
                "Typical household and battery behavior follows the historical local-time profile.",
                "Battery behavior is assumed unchanged by this added load."
            ]
        case .history:
            baseline = ["Banks follow your last four weeks of grid use through the bill date."]
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

    private static func completeCoverage(from start: Date, to end: Date, model: FlowModel,
                                         tariffs: [LoadTimingTariffSegment]) -> Bool {
        guard start < end else { return false }
        let points = integrationBoundaries(from: start, to: end, model: model, tariffs: tariffs)
        guard points.count >= 2 else { return false }
        for index in 0..<(points.count - 1) {
            let a = points[index]
            let b = points[index + 1]
            guard b > a else { return false }
            let midpoint = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
            guard model.hasForecast(at: midpoint) else { return false }
            guard tariffs.contains(where: { $0.start <= midpoint && midpoint < $0.end }) else { return false }
        }
        return points.first == start && points.last == end
    }

    private static func firstContextGap(from start: Date, to end: Date, model: FlowModel,
                                        tariffs: [LoadTimingTariffSegment]) -> Date? {
        guard model.projection.projectsFlow else { return nil }
        guard start < end else { return start }
        let points = integrationBoundaries(from: start, to: end, model: model, tariffs: tariffs)
        guard points.count >= 2 else { return start }
        for index in 0..<(points.count - 1) {
            let midpoint = points[index].addingTimeInterval(points[index + 1].timeIntervalSince(points[index]) / 2)
            guard model.hasContext(at: midpoint) else { return points[index] }
        }
        return nil
    }

    private static func integrationBoundaries(from start: Date, to end: Date, model: FlowModel,
                                              tariffs: [LoadTimingTariffSegment]) -> [Date] {
        var values: Set<Date> = [start, end]
        for interval in model.intervals {
            if interval.periodStart > start && interval.periodStart < end { values.insert(interval.periodStart) }
            if interval.periodEnd > start && interval.periodEnd < end { values.insert(interval.periodEnd) }
        }
        // The flow switches from the forecast to history here.
        if model.forecastEnd > start && model.forecastEnd < end { values.insert(model.forecastEnd) }
        for segment in tariffs {
            if segment.start > start && segment.start < end { values.insert(segment.start) }
            if segment.end > start && segment.end < end { values.insert(segment.end) }
        }
        // Context values change on local half-hour boundaries.
        values.formUnion(model.clock.halfHours(after: start, before: end))
        return values.sorted()
    }

    private static func integrateBaseline(from start: Date, to end: Date, balances: [String: Double],
                                          model: FlowModel, tariffs: [LoadTimingTariffSegment]) -> BaselineResult {
        var result = balances
        let points = integrationBoundaries(from: start, to: end, model: model, tariffs: tariffs)
        guard points.count >= 2 else { return .incompleteCoverage }
        for index in 0..<(points.count - 1) {
            let a = points[index], b = points[index + 1]
            let mid = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
            guard let flow = model.flow(at: mid),
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
                              model: FlowModel, tariffs: [LoadTimingTariffSegment], safetyEnd: Date) -> ScoreResult {
        var withLoad = baseBalances
        var drawsBySafetyEnd: [String: Double] = [:]
        var solarContribution = 0.0
        let points = integrationBoundaries(from: start, to: end, model: model, tariffs: tariffs)
        guard points.count >= 2 else { return .incompleteCoverage }
        let powerKw = load.energy / (load.duration / 3600)
        guard powerKw.isFinite, powerKw > 0 else { return .invalidInput }
        for index in 0..<(points.count - 1) {
            let a = points[index], b = points[index + 1]
            let mid = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
            guard let flow = model.flow(at: mid),
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
            if b <= safetyEnd { drawsBySafetyEnd[tariff.periodKey, default: 0] += energy }
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

    private static func cost(balance: Double, rate: PeriodRate) -> Double? {
        let importCost = max(-balance, 0) * rate.buy
        let exportCredit = max(balance, 0) * rate.sell
        let total = importCost - exportCredit
        guard importCost.isFinite, exportCredit.isFinite, total.isFinite else { return nil }
        return total
    }

    private static func candidateStarts(now: Date, horizonEnd: Date, duration: TimeInterval,
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

private extension Array {
    /// The first index whose element satisfies `predicate`, for a predicate that is
    /// false then true across the (sorted) array.
    func partitionPoint(where predicate: (Element) -> Bool) -> Int {
        var low = 0, high = count
        while low < high {
            let mid = (low + high) / 2
            if predicate(self[mid]) { high = mid } else { low = mid + 1 }
        }
        return low
    }
}
