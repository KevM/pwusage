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
    enum Projection: Equatable {
        case forecast(intervals: [SolarForecastInterval], context: PlanningContext)
        case history(context: PlanningContext)
        case flat(timeZone: String)

        enum Kind: String, Codable, Equatable {
            case forecast, history, flat
        }

        var kind: Kind {
            switch self {
            case .forecast: .forecast
            case .history: .history
            case .flat: .flat
            }
        }

        var timeZone: String {
            switch self {
            case .forecast(_, let context), .history(let context): context.timeZone
            case .flat(let timeZone): timeZone
            }
        }

        var maximumBalanceAge: TimeInterval {
            switch self {
            // Grid history fills the gap between the energy data and the forecast's
            // first interval, so only a forecast without it needs the 30-minute limit.
            case .forecast(_, let context) where context.hasGridHistory: LoadTimingForecastEstimator.maximumFlatBalanceAge
            case .forecast: LoadTimingForecastEstimator.maximumBalanceAge
            // Like `.flat`, the forecast-free card uses a one-hour balance window.
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

    struct BalancePoint: Codable, Equatable {
        let date: Date
        let kwh: Double
    }

    /// One rate period's signed balance from `now` to the horizon end, for the
    /// run starting now and for the recommended run, each on top of the baseline.
    struct BalanceLane: Codable, Equatable {
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

    struct Comparison: Codable, Equatable {
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
        /// The site's grid history moved the banks (with or after the forecast).
        let usesHistory: Bool

        init(costNow: Double, recommendedStart: Date, recommendedEnd: Date, recommendedCost: Double, savings: Double,
             bestAlternativeSavings: Double, estimatedSolarContribution: Double, horizonStart: Date, horizonEnd: Date,
             evaluatedStarts: [Date], assumptions: [String], hasUnobservedBalance: Bool, lanes: [BalanceLane],
             periodSwitches: [Date], projectionEnd: Date? = nil, projectionEndsAtRateChange: Bool = false,
             safetyEnd: Date? = nil, safety: Safety = .nowSafe, ruledOut: RuledOut? = nil, usesHistory: Bool = false) {
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
            self.usesHistory = usesHistory
        }
    }

    struct Result: Codable, Equatable {
        let comparison: Comparison?
        let unavailableReason: UnavailableReason?
    }

    fileprivate struct PeriodRate: Equatable {
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

    fileprivate enum BaselineResult {
        case balances([String: Double])
        case invalidInput
        case incompleteCoverage
    }

    /// The site's time zone and its local half-hour boundaries across the whole
    /// search. Integration and candidate starts both need those boundaries, and
    /// re-scanning them minute by minute for every candidate run dominated the
    /// cost of an evaluation, so they are scanned once.
    struct WallClock {
        /// Gregorian, in the site's time zone, for instants outside the scanned range.
        let calendar: Calendar
        private let halfHourBoundaries: [Date]
        /// The local minute-of-day each boundary starts.
        private let boundaryMinutes: [Int]
        private let start: Date
        private let end: Date
        /// The local half-hour slot in effect at `start`.
        private let startSlotMinute: Int

        init(timeZone: TimeZone, from start: Date, to end: Date) {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            self.calendar = calendar
            self.start = start
            self.end = end
            startSlotMinute = Self.slotMinute(at: start, calendar: calendar)
            // Every zone offset and DST shift is a whole quarter hour, so local
            // half-hour boundaries fall on UTC quarter hours. Scan those, reading
            // the zone's offset rather than a calendar, which is much cheaper
            // across a whole billing cycle.
            var boundaries: [Date] = []
            var minutes: [Int] = []
            let step = 15 * 60
            var cursor = (Int(floor(start.timeIntervalSince1970)) / step) * step + step
            if Double(cursor) <= start.timeIntervalSince1970 { cursor += step }
            // The offset only changes at a zone transition, so read it there.
            var offset = timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: Double(cursor)))
            var nextTransition = timeZone.nextDaylightSavingTimeTransition(after: Date(timeIntervalSince1970: Double(cursor)))
            while Double(cursor) < end.timeIntervalSince1970 {
                let date = Date(timeIntervalSince1970: Double(cursor))
                if let transition = nextTransition, date >= transition {
                    offset = timeZone.secondsFromGMT(for: date)
                    nextTransition = timeZone.nextDaylightSavingTimeTransition(after: date)
                }
                let local = cursor + offset
                let secondOfDay = ((local % 86_400) + 86_400) % 86_400
                if secondOfDay.isMultiple(of: 1800) {
                    boundaries.append(date)
                    minutes.append(secondOfDay / 60)
                }
                cursor += step
            }
            halfHourBoundaries = boundaries
            boundaryMinutes = minutes
        }

        /// Local half-hour boundaries strictly between `start` and `end`.
        func halfHours(after start: Date, before end: Date) -> ArraySlice<Date> {
            let lower = halfHourBoundaries.partitionPoint { $0 > start }
            let upper = halfHourBoundaries.partitionPoint { $0 >= end }
            return lower < upper ? halfHourBoundaries[lower..<upper] : []
        }

        /// The local minute-of-day starting the half-hour slot that contains `date`.
        /// Both occurrences of a repeated fall-back hour map to the same slots.
        func slotMinute(at date: Date) -> Int {
            guard date >= start, date < end else { return Self.slotMinute(at: date, calendar: calendar) }
            let index = halfHourBoundaries.partitionPoint { $0 > date }
            return index == 0 ? startSlotMinute : boundaryMinutes[index - 1]
        }

        private static func slotMinute(at date: Date, calendar: Calendar) -> Int {
            let components = calendar.dateComponents([.hour, .minute], from: date)
            return ((components.hour ?? 0) * 60 + (components.minute ?? 0)) / 30 * 30
        }
    }

    /// Household flow at one instant: what the baseline exports to the grid, and the
    /// solar left over after the home and any battery charging, which an added load can use.
    struct Flow {
        let netExportKw: Double
        let physicalSurplusKw: Double
    }

    /// Where the household flow at an instant comes from: the solar forecast
    /// with the household pattern before `forecastEnd`, the site's grid history
    /// after it (and throughout `.history`), or nothing for `.flat`.
    struct FlowModel {
        let projection: Projection
        let clock: WallClock
        /// The forecast drives the flow over [forecastStart, forecastEnd); history elsewhere.
        let forecastStart: Date
        let forecastEnd: Date
        /// Use `pv_estimate10` and the 1-in-4 week instead of the medians.
        let cautious: Bool
        private static let daysPerWeekRoot = 7.0.squareRoot()
        /// Forecast intervals that drive the flow (those starting before `forecastEnd`).
        let intervals: [SolarForecastInterval]
        private let slots: [Int: PlanningSlot]
        /// Every instant where the flow or the tariff can change, sorted: forecast
        /// interval edges, the switch to history, tariff edges and local half hours.
        private let boundaries: [Date]

        init(projection: Projection, clock: WallClock, forecastStart: Date = .distantPast, forecastEnd: Date,
             tariffs: [LoadTimingTariffSegment], cautious: Bool = false) {
            self.projection = projection
            self.clock = clock
            self.forecastStart = forecastStart
            self.forecastEnd = forecastEnd
            self.cautious = cautious
            intervals = projection.intervals.filter { $0.periodStart < forecastEnd }.sorted { $0.periodStart < $1.periodStart }
            // Each source is already in order, so a merge is cheaper than hashing and sorting.
            var edges = Array(clock.halfHours(after: .distantPast, before: .distantFuture))
            edges.append(contentsOf: intervals.flatMap { [$0.periodStart, $0.periodEnd] })
            edges.append(forecastStart)
            edges.append(forecastEnd)
            edges.append(contentsOf: tariffs.flatMap { [$0.start, $0.end] })
            edges.sort()
            var unique: [Date] = []
            unique.reserveCapacity(edges.count)
            for edge in edges where unique.last != edge { unique.append(edge) }
            boundaries = unique
            // A slot is usable only when its minute appears exactly once.
            let grouped = Dictionary(grouping: projection.context?.slots ?? [], by: \.localMinute)
            slots = grouped.compactMapValues { matches in
                guard matches.count == 1, let match = matches.first, match.localMinute >= 0,
                      match.localMinute < 1440, match.localMinute.isMultiple(of: 30) else { return nil }
                return match
            }
        }

        private init(cautiousCopyOf model: FlowModel) {
            projection = model.projection
            clock = model.clock
            forecastStart = model.forecastStart
            forecastEnd = model.forecastEnd
            cautious = true
            intervals = model.intervals
            slots = model.slots
            boundaries = model.boundaries
        }

        func cautiousModel() -> FlowModel { FlowModel(cautiousCopyOf: self) }

        /// `start`, every boundary strictly between, and `end`.
        func boundaries(from start: Date, to end: Date) -> [Date] {
            guard start < end else { return start == end ? [start] : [end, start].sorted() }
            let lower = boundaries.partitionPoint { $0 > start }
            let upper = boundaries.partitionPoint { $0 >= end }
            var values = [start]
            if lower < upper { values.append(contentsOf: boundaries[lower..<upper]) }
            values.append(end)
            return values
        }

        private func slot(at date: Date) -> PlanningSlot? {
            slots[clock.slotMinute(at: date)]
        }

        /// The forecast interval containing `date` (intervals are sorted and non-overlapping).
        private func interval(at date: Date) -> SolarForecastInterval? {
            let index = intervals.partitionPoint { $0.periodEnd > date }
            guard index < intervals.count, intervals[index].periodStart <= date else { return nil }
            return intervals[index]
        }

        private func usesForecast(at date: Date) -> Bool {
            if case .forecast = projection { return date >= forecastStart && date < forecastEnd }
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
            return interval(at: date) != nil
        }

        /// `nil` when the forecast, household pattern or history doesn't cover `date`. `.flat` never moves.
        func flow(at date: Date) -> Flow? {
            guard projection.projectsFlow else { return Flow(netExportKw: 0, physicalSurplusKw: 0) }
            guard let slot = slot(at: date) else { return nil }
            if usesForecast(at: date) {
                guard let interval = interval(at: date),
                      let home = slot.homeKw, let battery = slot.batteryNetChargeKw,
                      home.isFinite, battery.isFinite else { return nil }
                var solar = interval.powerKw
                if cautious, let dull = interval.cautiousPowerKw, dull.isFinite {
                    solar += (dull - solar) * LoadTimingForecastEstimator.forecastCautiousWeight
                }
                return Flow(netExportKw: solar - home - battery, physicalSurplusKw: solar - home - max(battery, 0))
            }
            guard let typical = slot.gridNetExportKw, typical.isFinite else { return nil }
            var grid = typical
            if cautious, let dull = slot.cautiousGridNetExportKw, dull.isFinite {
                // The server's dull day is a 1-in-4 *day*. Repeating it every day of
                // the safety window would be a week of dull days in a row, far rarer
                // than 1 in 4. A 1-in-4 week of roughly independent days falls short
                // of the typical week by about √7 dull-day gaps, so each day moves
                // 1/√7 of the way toward the dull day.
                grid = typical + (dull - typical) / Self.daysPerWeekRoot
            }
            // History records only what reached the grid; that export is what an added load could use.
            return Flow(netExportKw: grid, physicalSurplusKw: grid)
        }
    }

    /// The projection cut at every instant where the flow or the tariff can
    /// change, with each step's period and its typical and cautious flow. It is
    /// resolved once per plan, so pricing a run and drawing lanes walk arrays
    /// instead of looking the flow and tariff up at every point.
    fileprivate struct Steps {
        /// Step `i` runs from `edges[i]` to `edges[i + 1]`.
        let edges: [Date]
        let periods: [String]
        let typical: [Flow]
        let cautious: [Flow]

        /// `nil` when a forecast interval, the household pattern or history, or a
        /// tariff segment is missing somewhere in [start, end].
        init?(from start: Date, to end: Date, model: FlowModel, tariffs: [LoadTimingTariffSegment]) {
            let points = model.boundaries(from: start, to: end)
            guard start < end, points.count >= 2 else { return nil }
            let cautiousModel = model.cautiousModel()
            var periods: [String] = [], typical: [Flow] = [], cautious: [Flow] = []
            periods.reserveCapacity(points.count)
            typical.reserveCapacity(points.count)
            cautious.reserveCapacity(points.count)
            for index in 0..<(points.count - 1) {
                let a = points[index], b = points[index + 1]
                guard b > a else { return nil }
                let mid = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
                guard model.hasForecast(at: mid),
                      let tariff = LoadTimingForecastEstimator.segment(at: mid, in: tariffs),
                      let flow = model.flow(at: mid), let dull = cautiousModel.flow(at: mid) else { return nil }
                periods.append(tariff.periodKey)
                typical.append(flow)
                cautious.append(dull)
            }
            edges = points
            self.periods = periods
            self.typical = typical
            self.cautious = cautious
        }

        /// The step containing `date`, or `nil` outside the steps.
        func step(containing date: Date) -> Int? {
            guard let first = edges.first, let last = edges.last, date >= first, date < last else { return nil }
            return edges.partitionPoint { $0 > date } - 1
        }

        /// Integrates the typical (or cautious) flow over [start, end] onto `balances`.
        func integrate(from start: Date, to end: Date, balances: [String: Double], cautious useCautious: Bool) -> BaselineResult {
            var result = balances
            guard start < end, var index = step(containing: start), end <= edges[edges.count - 1] else {
                return .incompleteCoverage
            }
            while index < periods.count, edges[index] < end {
                let a = max(edges[index], start), b = min(edges[index + 1], end)
                guard let old = result[periods[index]] else { return .incompleteCoverage }
                let seconds = b.timeIntervalSince(a)
                let hours = seconds / 3600
                let netPower = useCautious ? cautious[index].netExportKw : typical[index].netExportKw
                let netExport = netPower * hours
                let updated = old + netExport
                guard seconds.isFinite, hours.isFinite, netPower.isFinite, netExport.isFinite, updated.isFinite else {
                    return .invalidInput
                }
                result[periods[index]] = updated
                index += 1
            }
            return .balances(result)
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
        evaluate(profile: profile, plan: plan(now: now, timing: timing, projection: projection,
                                              balanceSourceTime: balanceSourceTime, billingCycleEnd: billingCycleEnd,
                                              currencyCode: currencyCode))
    }

    /// Everything about an evaluation that doesn't depend on the Job: the
    /// projection, its coverage, and the typical and cautious baselines. Build
    /// it once per pass and price every Job against it.
    struct Plan {
        fileprivate let state: PlanState
    }

    fileprivate enum PlanState {
        case ready(Prepared)
        /// `beforeLoad` reasons were found before a Job's shape is checked, so they outrank an invalid Job.
        case unavailable(UnavailableReason, beforeLoad: Bool)
    }

    fileprivate struct Prepared {
        let now: Date
        let projection: Projection
        let projectionStart: Date
        let projectionEnd: Date
        let horizonEnd: Date
        let safetyEnd: Date
        let endsAtRateChange: Bool
        let tariffs: [LoadTimingTariffSegment]
        let model: FlowModel
        let steps: Steps
        let rates: [String: PeriodRate]
        /// Typical balances at the projection end, and at `now`.
        let baseBalances: [String: Double]
        let nowBalances: [String: Double]
        /// Cautious balances at the safety window's end, or `nil` when the safety
        /// rule doesn't apply (a forecast without grid history: see `plan`).
        let cautiousBalances: [String: Double]?
        let hasUnobservedBalance: Bool
        let minorUnit: Double
    }

    static func plan(
        now: Date,
        timing: LoadTiming,
        projection: Projection,
        balanceSourceTime: Date,
        billingCycleEnd: Date,
        currencyCode: String
    ) -> Plan {
        func unavailable(_ reason: UnavailableReason, beforeLoad: Bool = false) -> Plan {
            Plan(state: .unavailable(reason, beforeLoad: beforeLoad))
        }
        guard now.timeIntervalSince1970.isFinite, balanceSourceTime.timeIntervalSince1970.isFinite,
              billingCycleEnd.timeIntervalSince1970.isFinite, balanceSourceTime <= now else {
            return unavailable(.invalidInput, beforeLoad: true)
        }
        if let context = projection.context, !context.asOf.timeIntervalSince1970.isFinite {
            return unavailable(.invalidInput, beforeLoad: true)
        }
        guard now.timeIntervalSince(balanceSourceTime) <= projection.maximumBalanceAge else {
            return unavailable(.staleBalance, beforeLoad: true)
        }
        guard timing.hasTariff, !timing.tariffTimeline.isEmpty else { return unavailable(.missingTariff, beforeLoad: true) }
        if projection.projectsFlow, !timing.hasCycleData { return unavailable(.incompleteBalance, beforeLoad: true) }
        guard let zone = TimeZone(identifier: projection.timeZone) else { return unavailable(.invalidInput, beforeLoad: true) }
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
        var forecastStart = projectionStart
        var forecastEnd = projectionStart
        if case .forecast(let forecast, let context) = projection {
            if context.hasGridHistory {
                // The forecast must cover now, or history would stand in silently under
                // its name. A fresh batch starts at the current half hour, often after
                // the latest energy data, so history fills that short gap before it,
                // and after the forecast window or wherever the forecast falls short.
                guard let block = contiguousBlock(of: forecast, containing: now) else {
                    return unavailable(.incompleteCoverage)
                }
                forecastStart = max(block.start, projectionStart)
                forecastEnd = min(block.end, now.addingTimeInterval(Self.forecastWindow))
            } else {
                let coverageEnd = contiguousEnd(of: forecast, startingAt: projectionStart)
                guard coverageEnd > now else { return unavailable(.incompleteCoverage) }
                // Without history there is nothing to project past the forecast, and
                // an older server's context keeps today's horizon exactly.
                forecastEnd = coverageEnd
                projectionEnd = min(projectionEnd, coverageEnd, tomorrowEnd)
            }
        }
        projectionEnd = min(projectionEnd, contiguousTariffEnd(tariffs, startingAt: projectionStart))
        guard projectionEnd > now else { return unavailable(.incompleteCoverage) }
        let clock = WallClock(timeZone: zone, from: projectionStart, to: projectionEnd)
        let model = FlowModel(projection: projection, clock: clock, forecastStart: forecastStart, forecastEnd: forecastEnd,
                              tariffs: tariffs)

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

        // The forecast-free path reads no balances
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
            // Held still, an unobserved period is simply priced from zero and
            // flagged for the UI.
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
        guard let steps = Steps(from: projectionStart, to: projectionEnd, model: model, tariffs: tariffs) else {
            return unavailable(.incompleteCoverage)
        }

        let baseBalances: [String: Double]
        switch steps.integrate(from: projectionStart, to: projectionEnd, balances: balances, cautious: false) {
        case .balances(let projected): baseBalances = projected
        case .invalidInput: return unavailable(.invalidInput)
        case .incompleteCoverage: return unavailable(.incompleteCoverage)
        }
        // The cautious run (pv_estimate10, then a 1-in-4 week of history) is read only at the
        // safety window's end: history beyond it never makes a start pass.
        let safetyEnd = min(now.addingTimeInterval(Self.forecastWindow), projectionEnd)
        // Without grid history a forecast projection ends at midnight tomorrow, so
        // the safety window would shrink to one day and count none of the days a
        // bank recovers over. An older server keeps today's behavior: no rule.
        var cautiousBalances: [String: Double]?
        if case .forecast(_, let context) = projection, !context.hasGridHistory {
            cautiousBalances = nil
        } else {
            switch steps.integrate(from: projectionStart, to: safetyEnd, balances: balances, cautious: true) {
            case .balances(let projected): cautiousBalances = projected
            case .invalidInput: return unavailable(.invalidInput)
            case .incompleteCoverage: return unavailable(.incompleteCoverage)
            }
        }
        // The baseline from the end of observed data to now gives each lane's starting balance.
        var nowBalances = balances
        if projectionStart < now {
            guard case .balances(let projected) = steps.integrate(from: projectionStart, to: now, balances: balances,
                                                                  cautious: false) else {
                return unavailable(.invalidInput)
            }
            nowBalances = projected
        }
        return Plan(state: .ready(Prepared(
            now: now, projection: projection, projectionStart: projectionStart, projectionEnd: projectionEnd,
            horizonEnd: horizonEnd, safetyEnd: safetyEnd, endsAtRateChange: endsAtRateChange, tariffs: tariffs,
            model: model, steps: steps, rates: rates, baseBalances: baseBalances, nowBalances: nowBalances,
            cautiousBalances: cautiousBalances, hasUnobservedBalance: hasUnobservedBalance,
            minorUnit: currencyMinorUnit(currencyCode))))
    }

    /// Prices one Job against a plan built for this pass.
    static func evaluate(profile: LoadProfile, plan: Plan) -> Result {
        let prepared: Prepared
        switch plan.state {
        case .unavailable(let reason, beforeLoad: true): return unavailable(reason)
        case .unavailable(let reason, beforeLoad: false):
            guard loadShape(for: profile) != nil else { return loadUnavailable(profile) }
            return unavailable(reason)
        case .ready(let ready): prepared = ready
        }
        guard let load = loadShape(for: profile) else { return loadUnavailable(profile) }
        let now = prepared.now, horizonEnd = prepared.horizonEnd, projectionEnd = prepared.projectionEnd
        let model = prepared.model, tariffs = prepared.tariffs
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
                         baseBalances: prepared.baseBalances, rates: prepared.rates, steps: prepared.steps,
                         safetyEnd: prepared.safetyEnd) {
            case .candidate(let candidate): scored.append(candidate)
            case .invalidInput: return unavailable(.invalidInput)
            case .incompleteCoverage: return unavailable(.incompleteCoverage)
            }
        }
        guard let nowCandidate = scored.first(where: { $0.start == now }) else { return unavailable(.noFittingRun) }
        guard scored.allSatisfy({ $0.cost.isFinite }) else { return unavailable(.invalidInput) }
        let selection = select(scored.map {
            assess($0, baseBalances: prepared.baseBalances, cautiousBalances: prepared.cautiousBalances)
        }, now: now, minorUnit: prepared.minorUnit)
        let recommendation = selection.recommendation
        let savings = recommendation.start == nowCandidate.start ? 0 : max(0, nowCandidate.cost - recommendation.cost)
        guard let lanes = balanceLanes(now: now, horizonEnd: horizonEnd, nowBalances: prepared.nowBalances,
                                       baseBalances: prepared.baseBalances, load: load,
                                       startNow: nowCandidate, recommended: recommendation,
                                       steps: prepared.steps, tariffs: tariffs) else {
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
            assumptions: assumptions(for: prepared.projection),
            hasUnobservedBalance: prepared.hasUnobservedBalance,
            lanes: lanes,
            periodSwitches: periodSwitches(in: tariffs, after: now, before: horizonEnd),
            projectionEnd: projectionEnd,
            projectionEndsAtRateChange: prepared.endsAtRateChange,
            safetyEnd: prepared.safetyEnd,
            safety: selection.safety,
            ruledOut: selection.ruledOut,
            usesHistory: prepared.projection.context?.hasGridHistory ?? false
        ), unavailableReason: nil)
    }

    private static func loadUnavailable(_ profile: LoadProfile) -> Result {
        if profile.kind == .car, let settings = profile.carSettings,
           let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings), estimate.wallKwh == 0 {
            return unavailable(.noEnergyNeeded)
        }
        return unavailable(.invalidInput)
    }

    /// A run "dips into" a bank when the typical projection prices some of it at
    /// that period's sell rate: the bank ends the projection banked and the run
    /// draws on it. Each such bank is read in the cautious projection at the
    /// safety window's end, less the bank-covered part of the run's draw before then.
    private static func assess(_ candidate: Candidate, baseBalances: [String: Double],
                               cautiousBalances: [String: Double]?) -> Assessment {
        var worst: (periodKey: String, kwh: Double)?
        guard let cautiousBalances else { return Assessment(candidate: candidate, worst: nil) }
        for (key, draw) in candidate.draws.sorted(by: { $0.key < $1.key }) where draw > 0 {
            // Integration can leave a mathematically empty bank a few ULPs above
            // zero. That is no export cushion: it must not activate the safety
            // rule against a potentially large cautious deficit.
            guard let typical = baseBalances[key], typical > 1e-9, let cautious = cautiousBalances[key] else { continue }
            // Only the part the typical bank covers is priced at the sell rate and so
            // at risk in a cloudy week; an overdraw is already priced at the buy rate.
            let covered = min(candidate.drawsBySafetyEnd[key] ?? 0, typical)
            let remaining = cautious - covered
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

    private static func balanceLanes(now: Date, horizonEnd: Date, nowBalances: [String: Double],
                                     baseBalances: [String: Double], load: (energy: Double, duration: TimeInterval),
                                     startNow: Candidate, recommended: Candidate, steps: Steps,
                                     tariffs: [LoadTimingTariffSegment]) -> [BalanceLane]? {
        let powerKw = load.energy / (load.duration / 3600)
        guard let nowSeries = balanceSeries(from: now, to: horizonEnd, balances: nowBalances,
                                            run: (startNow.start, startNow.end), powerKw: powerKw, steps: steps),
              let recommendedSeries = balanceSeries(from: now, to: horizonEnd, balances: nowBalances,
                                                    run: (recommended.start, recommended.end), powerKw: powerKw,
                                                    steps: steps)
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
                                      run: (start: Date, end: Date), powerKw: Double,
                                      steps: Steps) -> [String: [BalancePoint]]? {
        guard start < end, var index = steps.step(containing: start), end <= steps.edges[steps.edges.count - 1] else {
            return nil
        }
        var current = balances
        var series = current.mapValues { [BalancePoint(date: start, kwh: $0)] }
        func advance(_ a: Date, _ b: Date, flow: Flow, periodKey: String) -> Bool {
            guard let old = current[periodKey] else { return false }
            let hours = b.timeIntervalSince(a) / 3600
            let draw = a >= run.start && b <= run.end ? powerKw * hours : 0
            let updated = old + flow.netExportKw * hours - draw
            guard updated.isFinite else { return false }
            current[periodKey] = updated
            for (key, kwh) in current { series[key, default: []].append(BalancePoint(date: b, kwh: kwh)) }
            return true
        }
        while index < steps.periods.count, steps.edges[index] < end {
            let a = max(steps.edges[index], start), b = min(steps.edges[index + 1], end)
            // The run's own edges split a step so its draw starts and stops on time.
            var cuts = [a]
            for edge in [run.start, run.end] where edge > a && edge < b { cuts.append(edge) }
            cuts.append(b)
            cuts.sort()
            for cut in 0..<(cuts.count - 1) {
                guard advance(cuts[cut], cuts[cut + 1], flow: steps.typical[index], periodKey: steps.periods[index]) else {
                    return nil
                }
            }
            index += 1
        }
        return series
    }

    /// The tariff segment containing `date` (the timeline is sorted and non-overlapping).
    fileprivate static func segment(at date: Date, in tariffs: [LoadTimingTariffSegment]) -> LoadTimingTariffSegment? {
        let index = tariffs.partitionPoint { $0.end > date }
        guard index < tariffs.count, tariffs[index].start <= date else { return nil }
        return tariffs[index]
    }

    private static func periodSwitches(in tariffs: [LoadTimingTariffSegment], after now: Date, before end: Date) -> [Date] {
        zip(tariffs, tariffs.dropFirst()).compactMap { previous, next in
            next.periodKey != previous.periodKey && next.start > now && next.start < end ? next.start : nil
        }
    }

    private static let safetyAssumption = "A start that dips into a bank must leave it no more than 3 kWh short after a cloudy week."

    private static func assumptions(for projection: Projection) -> [String] {
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

    /// The run of back-to-back forecast intervals that contains `date`, if any.
    private static func contiguousBlock(of forecast: [SolarForecastInterval], containing date: Date) -> (start: Date, end: Date)? {
        let intervals = forecast.sorted { $0.periodStart < $1.periodStart }
        guard var index = intervals.firstIndex(where: { $0.periodStart <= date && $0.periodEnd > date }) else { return nil }
        while index > 0, intervals[index - 1].periodEnd == intervals[index].periodStart { index -= 1 }
        return (intervals[index].periodStart, contiguousEnd(of: forecast, startingAt: date))
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
        model.boundaries(from: start, to: end)
    }

    private static func score(start: Date, end: Date, load: (energy: Double, duration: TimeInterval),
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
