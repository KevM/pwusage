import Foundation

/// What the forecast layer can contribute to the Smart Shift card right now.
enum ForecastAvailability: Equatable {
    /// No Solcast key on this device.
    case none
    case loading
    /// Connected, but the forecast comparison can't run; carries a one-sentence reason.
    case unusable(String)
    case ready
}

struct CostBar: Equatable {
    let label: String
    let amount: String
    let value: Double
    let isRecommended: Bool
}

/// A dashed rate-period switch on the chart, labelled "← Peak | Off-Peak →".
struct SwitchMarker: Equatable {
    let date: Date
    let label: String
    /// "← Peak": the period ending here, drawn just left of the line.
    let beforeLabel: String?
    /// "Off-Peak →": the period starting here, drawn just right of the line.
    let afterLabel: String?
}

/// One rate period's "energy weather" lane, from now to the end of the comparison.
struct LaneDisplay: Equatable {
    /// "Off-Peak bank (kWh)"
    let title: String
    /// "+18 kWh banked now", "−6 kWh owed now" or "0 kWh now"
    let startLabel: String
    let recommended: [LoadTimingForecastEstimator.BalancePoint]
    /// `nil` when the recommended start is now, so there is only one line.
    let startNow: [LoadTimingForecastEstimator.BalancePoint]?
    /// One label when both plans end at the same rounded value, else `[recommended, now]`.
    let endLabels: [String]
    let switches: [SwitchMarker]
}

struct SmartShiftVerdict: Equatable {
    enum Note: Equatable {
        /// `usesHistory`: banks followed the site's last four weeks rather than holding still.
        case connectSolcast(usesHistory: Bool)
        case forecastState(String)
        case unobservedBalance
    }

    let headline: String
    let barsCaption: String
    /// Recommended first; a single bar when the recommended start is now.
    let bars: [CostBar]
    /// "36% less"
    let percentLess: String?
    let why: String
    /// "Charge later"
    let laterLabel: String
    /// "Charge now"
    let nowLabel: String
    let lanes: [LaneDisplay]
    /// Clock times for the chart's x-axis: now, each run's end, and each switch.
    let axisDates: [Date]
    let notes: [Note]
    let accessibilitySummary: String
}

/// One rate period in "How this is worked out".
struct PeriodRow: Equatable {
    let name: String
    let buy: String
    let sell: String
    /// "+18 kWh banked", "−6 kWh owed", "0 kWh" or "No balance yet".
    let balance: String
}

/// One priced part of a run: energy from a bank (its credit given up) or bought (its buy rate).
struct CostLine: Equatable {
    let period: String
    /// "31.5 kWh from your bank × 4¢/kWh credit" or "21.2 kWh bought × 10¢/kWh"
    let detail: String
    let amount: String
}

/// What one start time adds to the bill, as arithmetic that sums to its cost bar.
struct CostBreakdown: Equatable {
    /// "Charge tomorrow at 4:30 PM" or "Charge now"
    let title: String
    let total: String
    let lines: [CostLine]
    /// Explains a bank the run uses that the forecast fills beyond today's balance.
    let notes: [String]
}

/// Points at another saved Job that waiting would save more on right now.
struct BetterJobHint: Equatable {
    let id: String
    let text: String
}

struct SmartShiftScreen: Equatable {
    enum Content: Equatable {
        case verdict(SmartShiftVerdict)
        case blocked(String)
        case noJobs
    }

    let content: Content
}

/// The comparison the card shows, and what the forecast layer contributed to it.
struct SmartShiftEvaluation: Equatable {
    let result: LoadTimingForecastEstimator.Result
    let forecast: ForecastAvailability
    /// The projection that priced `result`; `nil` when none could run.
    var projection: LoadTimingForecastEstimator.Projection.Kind? = nil
}

/// Every Smart Shift sentence and display decision, kept out of the views so it can be tested.
enum SmartShiftPresentation {
    /// Prices the Job with the solar forecast when one is ready, otherwise with
    /// the site's grid history when the household pattern carries it, otherwise
    /// with balances held still. A forecast comparison that can't run (its
    /// stricter 30-minute balance age, say) falls back to the forecast-free one,
    /// and the card says why in one sentence.
    static func evaluate(
        profile: LoadProfile,
        now: Date,
        timing: LoadTiming,
        forecast: ForecastAvailability,
        intervals: [SolarForecastInterval]?,
        context: LoadTimingForecastEstimator.PlanningContext?,
        balanceSourceTime: Date?,
        billingCycleEnd: Date,
        currencyCode: String,
        timeZone: String
    ) -> SmartShiftEvaluation {
        evaluator(now: now, timing: timing, forecast: forecast, intervals: intervals, context: context,
                  balanceSourceTime: balanceSourceTime, billingCycleEnd: billingCycleEnd,
                  currencyCode: currencyCode, timeZone: timeZone)(profile)
    }

    /// Prices Jobs for one pass, as `evaluate` does. The projection work that
    /// doesn't depend on the Job is planned once per projection and shared, so
    /// pricing every saved Job for the hint stays within the per-pass budget.
    static func evaluator(
        now: Date,
        timing: LoadTiming,
        forecast: ForecastAvailability,
        intervals: [SolarForecastInterval]?,
        context: LoadTimingForecastEstimator.PlanningContext?,
        balanceSourceTime: Date?,
        billingCycleEnd: Date,
        currencyCode: String,
        timeZone: String
    ) -> (LoadProfile) -> SmartShiftEvaluation {
        guard let balanceSourceTime else {
            return { _ in SmartShiftEvaluation(result: .init(comparison: nil, unavailableReason: .staleBalance), forecast: forecast) }
        }
        let plans = PassPlans { projection in
            LoadTimingForecastEstimator.plan(now: now, timing: timing, projection: projection,
                                             balanceSourceTime: balanceSourceTime, billingCycleEnd: billingCycleEnd,
                                             currencyCode: currencyCode)
        }
        return { profile in
            var availability = forecast
            if forecast == .ready, let intervals, let context {
                let result = LoadTimingForecastEstimator.evaluate(
                    profile: profile, plan: plans.plan(for: .forecast(intervals: intervals, context: context)))
                guard let reason = result.unavailableReason else {
                    return SmartShiftEvaluation(result: result, forecast: .ready, projection: .forecast)
                }
                availability = .unusable(LoadTimingForecastPresentation.forecastUnavailableNote(reason))
            } else if forecast == .ready {
                availability = .unusable(LoadTimingForecastPresentation.forecastUnavailableNote(.incompleteContext))
            }
            if let context, context.hasGridHistory {
                let result = LoadTimingForecastEstimator.evaluate(profile: profile, plan: plans.plan(for: .history(context: context)))
                if result.unavailableReason == nil {
                    return SmartShiftEvaluation(result: result, forecast: availability, projection: .history)
                }
            }
            return SmartShiftEvaluation(
                result: LoadTimingForecastEstimator.evaluate(profile: profile, plan: plans.plan(for: .flat(timeZone: timeZone))),
                forecast: availability, projection: .flat)
        }
    }

    /// Each projection's plan for one pass, built the first time a Job needs it.
    private final class PassPlans {
        private let make: (LoadTimingForecastEstimator.Projection) -> LoadTimingForecastEstimator.Plan
        private var built: [(LoadTimingForecastEstimator.Projection, LoadTimingForecastEstimator.Plan)] = []

        init(make: @escaping (LoadTimingForecastEstimator.Projection) -> LoadTimingForecastEstimator.Plan) {
            self.make = make
        }

        func plan(for projection: LoadTimingForecastEstimator.Projection) -> LoadTimingForecastEstimator.Plan {
            if let hit = built.first(where: { $0.0 == projection }) { return hit.1 }
            let plan = make(projection)
            built.append((projection, plan))
            return plan
        }
    }

    /// When the card's comparison goes stale on its own: the recommended start
    /// arriving, or the rate period changing. The comparison is computed once per
    /// body pass, so the view schedules a pass for then rather than ticking.
    static func nextRefresh(comparison: LoadTimingForecastEstimator.Comparison?, now: Date) -> Date? {
        guard let comparison else { return nil }
        return ([comparison.recommendedStart] + comparison.periodSwitches).filter { $0 > now }.min()
    }

    static let connectSolcastNote = "Without a solar forecast, banks are shown as they stand now. Connect Solcast to see today's solar."
    static let connectSolcastHistoryNote = "Without a solar forecast, banks follow your last four weeks. Connect Solcast to see this week's solar."
    static let checkingSolarNote = "Checking today's solar…"
    static let unobservedBalanceNote = "Some rate periods have no balance yet, so they're priced at the full rate."

    static let refreshFailedMessage = "The latest refresh failed, so this saved estimate may be old and no recommendation is offered."
    static let staleMessage = "Energy observations are older than one hour or have no valid source time, so no recommendation is offered."
    static let missingRatePlanMessage = "Add a Rate Plan so Smart Shift can compare costs."
    static let incompleteBalanceMessage = "Some rate periods or balances are missing from your Rate Plan, so costs can't be compared."
    static let billingCycleMessage = "This job would continue beyond the current billing cycle, so its current bank can't be used for the estimate."
    static let tooLongMessage = "This job is longer than the time Smart Shift can compare right now."
    static let noEnergyMessage = "This car is already at its target charge, so no energy is needed right now."
    static let cannotCompareMessage = "Smart Shift can't compare start times for this job right now."

    static func make(
        profile: LoadProfile?,
        result: LoadTimingForecastEstimator.Result,
        forecast: ForecastAvailability,
        refreshUnavailable: Bool,
        timing: LoadTiming,
        now: Date,
        billingCycleEnd: Date,
        currencyCode: String,
        timeZone: String
    ) -> SmartShiftScreen {
        guard let profile else { return SmartShiftScreen(content: .noJobs) }
        if let message = blockedMessage(profile: profile, result: result, refreshUnavailable: refreshUnavailable,
                                        timing: timing, now: now, billingCycleEnd: billingCycleEnd) {
            return SmartShiftScreen(content: .blocked(message))
        }
        guard let comparison = result.comparison else { return SmartShiftScreen(content: .blocked(cannotCompareMessage)) }
        let context = Context(profile: profile, comparison: comparison, timing: timing, now: now,
                              billingCycleEnd: billingCycleEnd, currencyCode: currencyCode, timeZone: timeZone)
        return SmartShiftScreen(content: .verdict(context.verdict(forecast: forecast)))
    }

    // MARK: - How this is worked out

    /// "Off-Peak" for a server key like "OFF_PEAK"; tariff names pass through.
    static func periodTitle(_ key: String, timing: LoadTiming) -> String {
        DashboardPresentation.tariffPeriodTitle(timing.tariffTimeline.first { $0.periodKey == key }?.name ?? key)
    }

    /// Every pricing period, in the order the tariff reaches them.
    static func periodRows(timing: LoadTiming, currencyCode: String) -> [PeriodRow] {
        var order: [String] = []
        for segment in timing.tariffTimeline.sorted(by: { $0.start < $1.start }) where !order.contains(segment.periodKey) {
            order.append(segment.periodKey)
        }
        let periods = timing.pricingPeriods.enumerated().sorted { left, right in
            (order.firstIndex(of: left.element.name) ?? order.count + left.offset)
                < (order.firstIndex(of: right.element.name) ?? order.count + right.offset)
        }
        return periods.map { _, period in
            PeriodRow(
                name: periodTitle(period.name, timing: timing),
                buy: DashboardPresentation.loadRate(period.buyRate, code: currencyCode),
                sell: DashboardPresentation.loadRate(period.sellRate, code: currencyCode),
                balance: timing.hasCycleData ? balanceLabel(period.cycleNetExportKwh) : "No balance yet"
            )
        }
    }

    /// For each period the recommended run draws on: the part its bank covers and the part bought.
    /// Banks are read where the bill is, at the projection end: the lane's bank after
    /// the run plus the run's draw gives the bank it drew from.
    /// The recommended start's arithmetic, then starting now's (just now's when they're the same).
    static func costBreakdowns(comparison: LoadTimingForecastEstimator.Comparison, profile: LoadProfile, timing: LoadTiming,
                               now: Date, billingCycleEnd: Date, currencyCode: String, timeZone: String) -> [CostBreakdown] {
        Context(profile: profile, comparison: comparison, timing: timing, now: now, billingCycleEnd: billingCycleEnd,
                currencyCode: currencyCode, timeZone: timeZone).costBreakdowns
    }

    /// "Charging tomorrow at 8:00 AM would be cheaper if the sun holds, but …", when the
    /// safety rule turned down a cheaper start; otherwise `nil`.
    static func ruledOutNote(comparison: LoadTimingForecastEstimator.Comparison, profile: LoadProfile, timing: LoadTiming,
                             now: Date, timeZone: String) -> String? {
        guard let ruledOut = comparison.ruledOut else { return nil }
        let context = Context(profile: profile, comparison: comparison, timing: timing, now: now, billingCycleEnd: nil,
                              currencyCode: "USD", timeZone: timeZone)
        let time = ruledOut.start <= comparison.horizonStart ? "now" : context.when(ruledOut.start)
        return "\(gerund(context.verb)) \(time) would be cheaper if the sun holds, but a cloudy week could leave "
            + "\(context.name(ruledOut.periodKey)) more than \(shortfallKwh) kWh short by "
            + "\(shortDate(comparison.safetyEnd, timeZone: timeZone)), so it isn't suggested."
    }

    /// "3", the most a cloudy week may leave a bank short.
    static var shortfallKwh: String {
        LoadTimingForecastEstimator.safetyShortfallKwh.formatted(.number.precision(.fractionLength(0)))
    }

    /// "Nov 10" in the site's time zone.
    static func shortDate(_ date: Date, timeZone: String) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: timeZone) ?? .current
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
        return formatter.string(from: date)
    }

    /// "Charge" → "Charging", "Wash" → "Washing", "Start" → "Starting", "Bake" → "Baking".
    static func gerund(_ verb: String) -> String {
        let lower = verb.lowercased()
        if lower.hasSuffix("e"), !lower.hasSuffix("ee"), !lower.hasSuffix("ye"), !lower.hasSuffix("oe"), lower.count > 2 {
            return String(verb.dropLast()) + "ing"
        }
        // A short consonant-vowel-consonant verb doubles its last letter: "Run" → "Running".
        let vowels = Set("aeiou")
        let letters = Array(lower)
        if letters.count == 3, !vowels.contains(letters[0]), vowels.contains(letters[1]),
           !vowels.contains(letters[2]), !"wxy".contains(letters[2]) {
            return verb + String(verb.last!) + "ing"
        }
        return verb + "ing"
    }

    struct Draw {
        let key: String
        let kwh: Double
        let fromBank: Double
        /// The period's projected bank without this run, when its lane is known.
        let bankWithoutRun: Double?
    }

    /// What a run takes from each period, in the order it reaches them, and how much
    /// of that its bank covers. A lane ends `kwh` lower than it would without the run,
    /// so the bank it drew from is that lane's end plus the draw.
    static func draws(from start: Date, to end: Date, profile: LoadProfile, timing: LoadTiming,
                      laneEnd: (LoadTimingForecastEstimator.BalanceLane) -> Double?,
                      lanes: [LoadTimingForecastEstimator.BalanceLane]) -> [Draw] {
        let hours = end.timeIntervalSince(start) / 3600
        guard hours > 0, let energy = energyKwh(of: profile), energy > 0 else { return [] }
        let powerKw = energy / hours
        return hoursByPeriod(from: start, to: end, timing: timing).map { key, periodHours in
            let drawn = powerKw * periodHours
            let bank = lanes.first { $0.periodKey == key }.flatMap(laneEnd).map { $0 + drawn }
            return Draw(key: key, kwh: drawn, fromBank: bank.map { min(drawn, max($0, 0)) } ?? 0, bankWithoutRun: bank)
        }
    }

    /// Hours a run spends in each rate period, in the order it reaches them.
    static func hoursByPeriod(from start: Date, to end: Date, timing: LoadTiming) -> [(key: String, hours: Double)] {
        var result: [(key: String, hours: Double)] = []
        for segment in timing.tariffTimeline.sorted(by: { $0.start < $1.start }) where segment.start < end && segment.end > start {
            let overlap = min(segment.end, end).timeIntervalSince(max(segment.start, start)) / 3600
            if let index = result.firstIndex(where: { $0.key == segment.periodKey }) {
                result[index].hours += overlap
            } else {
                result.append((segment.periodKey, overlap))
            }
        }
        return result
    }

    // MARK: - A better Job

    /// "Wash the dishes: save about $2.10 by waiting", when another Job's saving
    /// beats the selected one's by more than a minor unit; otherwise `nil`.
    static func betterJobHint(selectedID: String, savingsByJob: [(LoadProfile, Double)], currencyCode: String) -> BetterJobHint? {
        let selected = savingsByJob.first { $0.0.id == selectedID }?.1 ?? 0
        let minorUnit = LoadTimingForecastEstimator.currencyMinorUnit(currencyCode)
        guard let (profile, savings) = savingsByJob
            .filter({ $0.0.id != selectedID && $0.1.isFinite })
            .max(by: { $0.1 < $1.1 }),
              savings > minorUnit, savings - selected > minorUnit else { return nil }
        return BetterJobHint(id: profile.id,
                             text: "\(profile.name): save about \(DashboardPresentation.currency(savings, code: currencyCode)) by waiting")
    }

    // MARK: - Blocked states

    private static func blockedMessage(profile: LoadProfile, result: LoadTimingForecastEstimator.Result,
                                       refreshUnavailable: Bool, timing: LoadTiming, now: Date,
                                       billingCycleEnd: Date) -> String? {
        if refreshUnavailable { return refreshFailedMessage }
        if !timing.hasTariff { return missingRatePlanMessage }
        switch result.unavailableReason {
        case .none:
            return nil
        case .staleBalance:
            return staleMessage
        case .missingTariff:
            return missingRatePlanMessage
        case .incompleteBalance:
            return incompleteBalanceMessage
        case .noFittingRun:
            if let hours = durationHours(of: profile), now.addingTimeInterval(hours * 3600) > billingCycleEnd {
                return billingCycleMessage
            }
            return tooLongMessage
        case .noEnergyNeeded:
            return noEnergyMessage
        case .invalidInput, .incompleteCoverage, .incompleteContext:
            return cannotCompareMessage
        }
    }

    static func durationHours(of profile: LoadProfile) -> Double? {
        if profile.kind == .car {
            return profile.carSettings.flatMap(LoadTimingEstimator.carChargeEstimate(settings:))?.durationHours
        }
        return profile.durationHours
    }

    static func energyKwh(of profile: LoadProfile) -> Double? {
        if profile.kind == .car {
            return profile.carSettings.flatMap(LoadTimingEstimator.carChargeEstimate(settings:))?.wallKwh
        }
        return profile.energyKwh
    }

    // MARK: - Number formats

    /// Whole kWh with a sign: "+18", "−6", "0". Uses a true minus sign.
    static func signedKwh(_ kwh: Double) -> String {
        let value = roundedKwh(kwh)
        if value > 0 { return "+\(value)" }
        if value < 0 { return "\u{2212}\(-value)" }
        return "0"
    }

    /// "+18 kWh banked", "−6 kWh owed" or "0 kWh".
    static func balanceLabel(_ kwh: Double) -> String {
        let value = roundedKwh(kwh)
        if value > 0 { return "\(signedKwh(kwh)) kWh banked" }
        if value < 0 { return "\(signedKwh(kwh)) kWh owed" }
        return "0 kWh"
    }

    static func startLabel(_ kwh: Double) -> String { "\(balanceLabel(kwh)) now" }

    /// The unsigned spoken form for VoiceOver: "6 kWh owed".
    private static func spokenBalance(_ kwh: Double) -> String {
        let value = roundedKwh(kwh)
        if value > 0 { return "\(value) kWh banked" }
        if value < 0 { return "\(-value) kWh owed" }
        return "0 kWh"
    }

    private static func roundedKwh(_ kwh: Double) -> Int {
        guard kwh.isFinite else { return 0 }
        return Int(kwh.rounded())
    }

    // MARK: - Verdict

    private struct Context {
        let profile: LoadProfile
        let comparison: LoadTimingForecastEstimator.Comparison
        let timing: LoadTiming
        let now: Date
        /// `nil` where no bill date is shown.
        let billingCycleEnd: Date?
        let currencyCode: String
        let timeZone: String

        var isNow: Bool { comparison.recommendedStart <= comparison.horizonStart }

        func shortDate(_ date: Date) -> String { SmartShiftPresentation.shortDate(date, timeZone: timeZone) }

        var verb: String {
            guard profile.kind != .custom, let first = profile.name.split(separator: " ").first else { return "Start" }
            return String(first)
        }

        var laterLabel: String { "\(verb) later" }
        var nowLabel: String { "\(verb) now" }

        func money(_ amount: Double) -> String { DashboardPresentation.currency(amount, code: currencyCode) }

        /// "at 4:30 PM", or "tomorrow at 4:30 PM" when the start falls on a later local day,
        /// with the day first so it can't be missed.
        func when(_ date: Date) -> String {
            let clock = DashboardPresentation.date(date, timeZoneIdentifier: timeZone, dateStyle: .none, timeStyle: .short)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: timeZone) ?? .current
            return calendar.isDate(date, inSameDayAs: now) ? "at \(clock)" : "tomorrow at \(clock)"
        }

        func capitalized(_ phrase: String) -> String {
            phrase.prefix(1).uppercased() + phrase.dropFirst()
        }

        func name(_ key: String) -> String {
            periodTitle(key, timing: timing)
        }

        func periodKey(at date: Date) -> String? {
            timing.tariffTimeline.first { $0.start <= date && date < $0.end }?.periodKey
        }

        func startKwh(_ key: String) -> Double? {
            comparison.lanes.first { $0.periodKey == key }?.startKwh
        }

        func bankPhrase(_ key: String) -> String {
            let kwh = startKwh(key) ?? 0
            return roundedKwh(kwh) > 0 ? "have \(roundedKwh(kwh)) kWh banked" : "have no bank"
        }

        var headline: String {
            let time = isNow ? "now" : when(comparison.recommendedStart)
            // A safe start that is also cheaper than now keeps the saving headline.
            if claimsSaving {
                return "\(profile.name) \(time): about \(money(comparison.savings)) cheaper than now"
            }
            switch comparison.safety {
            case .nowSafe:
                return "\(profile.name) now: no cheaper time today"
            case .nowUnsafe(let key):
                let more = max(0, comparison.recommendedCost - comparison.costNow)
                return "\(profile.name) \(time): about \(money(more)) more than now, but it won't leave \(name(key)) short"
            case .noSafeStart(let key):
                return "\(profile.name) \(time): the least risky time, but a cloudy week could still leave \(name(key)) short"
            }
        }

        /// Shorter is better only when the recommendation is also the cheaper bar:
        /// never when no start is safe, and not when the safe start costs more than now.
        var claimsSaving: Bool {
            guard !isNow else { return false }
            switch comparison.safety {
            case .nowSafe: return true
            case .nowUnsafe:
                return comparison.costNow - comparison.recommendedCost > LoadTimingForecastEstimator.currencyMinorUnit(currencyCode)
            case .noSafeStart: return false
            }
        }

        func verdict(forecast: ForecastAvailability) -> SmartShiftVerdict {
            let nowBar = CostBar(label: nowLabel, amount: money(comparison.costNow), value: comparison.costNow, isRecommended: isNow)
            let bars = isNow
                ? [nowBar]
                : [CostBar(label: laterLabel, amount: money(comparison.recommendedCost), value: comparison.recommendedCost,
                           isRecommended: true), nowBar]
            let lanes = comparison.lanes.map(lane)
            return SmartShiftVerdict(
                headline: headline,
                barsCaption: claimsSaving ? "Added to your bill (shorter is better)" : "Added to your bill",
                bars: bars,
                percentLess: percentLess,
                why: why,
                laterLabel: laterLabel,
                nowLabel: nowLabel,
                lanes: lanes,
                axisDates: axisDates,
                notes: notes(forecast: forecast),
                accessibilitySummary: accessibilitySummary
            )
        }

        var switchMarkers: [SwitchMarker] {
            comparison.periodSwitches.map { date in
                let before = timing.tariffTimeline.first { $0.end == date }.map { name($0.periodKey) }
                let after = timing.tariffTimeline.first { $0.start == date }.map { name($0.periodKey) }
                let beforeLabel = before.map { "\u{2190} \($0)" }, afterLabel = after.map { "\($0) \u{2192}" }
                let label = [beforeLabel, afterLabel].compactMap { $0 }.joined(separator: " | ")
                return SwitchMarker(date: date, label: label, beforeLabel: beforeLabel, afterLabel: afterLabel)
            }
        }

        var axisDates: [Date] {
            let duration = comparison.recommendedEnd.timeIntervalSince(comparison.recommendedStart)
            let ends = [now.addingTimeInterval(duration), comparison.recommendedEnd]
            let dates = Set([now] + ends + comparison.periodSwitches)
            return dates.filter { $0 >= now && $0 <= comparison.horizonEnd }.sorted()
        }

        var percentLess: String? {
            guard claimsSaving, comparison.costNow > 0 else { return nil }
            let percent = Int(((comparison.costNow - comparison.recommendedCost) / comparison.costNow * 100).rounded())
            return percent > 0 ? "\(percent)% less" : nil
        }

        var why: String {
            if isNow {
                guard let key = periodKey(at: now) else { return "" }
                let period = name(key)
                // Priced, like the cost, against each bank at the projection end, not today's.
                let draws = nowDraws
                let total = draws.reduce(0) { $0 + $1.kwh }
                let covered = draws.reduce(0) { $0 + $1.fromBank }
                guard roundedKwh(covered) > 0 else { return "It's \(period); this run is bought at the full rate." }
                let share = total <= 0 || covered >= total - 0.05 ? "all" : covered / total >= 0.5 ? "most" : "some"
                let banks = draws.count > 1 ? "your banks cover" : "your \(period) bank covers"
                return "It's \(period), and \(banks) \(share) of this run."
            }
            let nowDraws = self.nowDraws
            let laterDraws = self.laterDraws
            let time = when(comparison.recommendedStart)
            if case .nowUnsafe(let key) = comparison.safety {
                let warning = "Starting now would draw on your \(name(key)) bank, which a cloudy week could leave more than "
                    + "\(shortfallKwh) kWh short by \(shortDate(comparison.safetyEnd))."
                guard let laterMain = laterDraws.max(by: { $0.kwh < $1.kwh }) else { return warning }
                return warning + " " + laterClause(laterMain, total: laterDraws.reduce(0) { $0 + $1.kwh }, time: time)
            }
            guard let nowMain = nowDraws.max(by: { $0.kwh < $1.kwh }),
                  let laterMain = laterDraws.max(by: { $0.kwh < $1.kwh }) else {
                return "Starting \(time) costs less than starting now."
            }
            if nowMain.key != laterMain.key {
                return nowClause(nowMain, crossesPeriods: nowDraws.count > 1) + " "
                    + laterClause(laterMain, total: laterDraws.reduce(0) { $0 + $1.kwh }, time: time)
            }
            // Both runs lean on the same period, so the saving comes from how the
            // energy splits: name the period starting now puts more into.
            let laterKwh = Dictionary(uniqueKeysWithValues: laterDraws.map { ($0.key, $0.kwh) })
            if let heavier = nowDraws
                .map({ (key: $0.key, extra: $0.kwh - (laterKwh[$0.key] ?? 0)) })
                .filter({ $0.extra > 0.000_001 })
                .max(by: { $0.extra < $1.extra })?.key {
                return "Starting now puts more of it in \(name(heavier)), where you \(bankPhrase(heavier)). "
                    + "Run \(time) so less of it lands there."
            }
            return "Starting \(time) costs less than starting now."
        }

        func rateValue(_ key: String, sell: Bool) -> Double? {
            let segment = timing.tariffTimeline.first { $0.periodKey == key }
            return sell ? segment?.sellRate : segment?.buyRate
        }

        func rate(_ key: String, sell: Bool) -> String {
            DashboardPresentation.loadRate(rateValue(key, sell: sell), code: currencyCode)
        }

        /// Starting now's draws, against each bank at the projection end.
        var nowDraws: [Draw] {
            let duration = comparison.recommendedEnd.timeIntervalSince(comparison.recommendedStart)
            return draws(from: now, to: now.addingTimeInterval(duration), profile: profile, timing: timing,
                         laneEnd: { $0.projectedAfterStartNowKwh }, lanes: comparison.lanes)
        }

        /// The recommended start's draws, against each bank at the projection end.
        var laterDraws: [Draw] {
            draws(from: comparison.recommendedStart, to: comparison.recommendedEnd, profile: profile, timing: timing,
                  laneEnd: { $0.projectedAfterRecommendedKwh }, lanes: comparison.lanes)
        }

        var costBreakdowns: [CostBreakdown] {
            let startNow = breakdown(title: nowLabel, total: comparison.costNow, draws: nowDraws)
            guard !isNow else { return [startNow] }
            let later = breakdown(title: "\(verb) \(when(comparison.recommendedStart))", total: comparison.recommendedCost,
                                  draws: laterDraws)
            return [later, startNow]
        }

        /// "by Nov 10 (bill date)", "by Nov 1, when rates change," or "by Oct 20".
        var projectionEndPhrase: String {
            let date = shortDate(comparison.projectionEnd)
            if comparison.projectionEndsAtRateChange { return "by \(date), when rates change," }
            if let billingCycleEnd, comparison.projectionEnd == billingCycleEnd { return "by \(date) (bill date)," }
            return "by \(date),"
        }

        func breakdown(title: String, total: Double, draws: [Draw]) -> CostBreakdown {
            let kwh: (Double) -> String = { $0.formatted(.number.precision(.fractionLength(1))) }
            var lines: [CostLine] = []
            var notes: [String] = []
            for draw in draws {
                let period = name(draw.key)
                let bought = draw.kwh - draw.fromBank
                if draw.fromBank >= 0.05 {
                    lines.append(CostLine(period: period, detail: "\(kwh(draw.fromBank)) kWh from your bank × \(rate(draw.key, sell: true)) credit",
                                          amount: money(draw.fromBank * (rateValue(draw.key, sell: true) ?? 0))))
                    if let projected = draw.bankWithoutRun {
                        let today = startKwh(draw.key) ?? 0
                        notes.append("\(period) bank is \(signedKwh(today)) now, projecting \(signedKwh(projected)) "
                            + "\(projectionEndPhrase) \(signedKwh(projected - draw.kwh)) after this charge.")
                    }
                }
                if bought >= 0.05 {
                    lines.append(CostLine(period: period, detail: "\(kwh(bought)) kWh bought × \(rate(draw.key, sell: false))",
                                          amount: money(bought * (rateValue(draw.key, sell: false) ?? 0))))
                }
            }
            return CostBreakdown(title: title, total: money(total), lines: lines, notes: notes)
        }

        /// Why starting now costs what it does: bought at the period's rate, or its bank's credit given up.
        func nowClause(_ draw: Draw, crossesPeriods: Bool) -> String {
            let period = name(draw.key)
            if draw.fromBank >= draw.kwh / 2 {
                return "Starting now uses your \(period) bank, giving up \(rate(draw.key, sell: true)) in credit."
            }
            let bought = draw.fromBank > 0.05 ? "most of it is bought" : "it's bought"
            return "Starting now runs \(crossesPeriods ? "into" : "during") \(period), where you \(bankPhrase(draw.key)), "
                + "so \(bought) at \(rate(draw.key, sell: false))."
        }

        /// What the later start uses instead. A bank larger than today's means the
        /// forecast expects solar to fill it before the run.
        func laterClause(_ draw: Draw, total: Double, time: String) -> String {
            let period = name(draw.key)
            let mostly = total > 0 && draw.kwh / total < 0.95 ? "mostly " : ""
            guard draw.fromBank >= draw.kwh / 2 else {
                return "\(capitalized(time)) it's \(mostly)bought at the \(period) rate of \(rate(draw.key, sell: false))."
            }
            // A bank larger than today's is filled by projected solar across the
            // days to the projection end, not by tomorrow alone, so say where it stands then.
            let projected = draw.fromBank > max(startKwh(draw.key) ?? 0, 0) + 0.5
                ? draw.bankWithoutRun.map { ", projected at \(signedKwh($0)) kWh by \(shortDate(comparison.projectionEnd))" } ?? ""
                : ""
            return "\(capitalized(time)) it \(mostly)uses your \(period) bank\(projected), giving up \(rate(draw.key, sell: true)) in credit."
        }

        func lane(_ lane: LoadTimingForecastEstimator.BalanceLane) -> LaneDisplay {
            let laterEnd = lane.recommended.last?.kwh ?? lane.startKwh
            let nowEnd = lane.startNow.last?.kwh ?? lane.startKwh
            let endLabels = isNow || signedKwh(laterEnd) == signedKwh(nowEnd)
                ? [signedKwh(laterEnd)]
                : [signedKwh(laterEnd), signedKwh(nowEnd)]
            return LaneDisplay(
                title: "\(name(lane.periodKey)) bank (kWh)",
                startLabel: startLabel(lane.startKwh),
                recommended: lane.recommended,
                startNow: isNow ? nil : lane.startNow,
                endLabels: endLabels,
                switches: switchMarkers
            )
        }

        func notes(forecast: ForecastAvailability) -> [SmartShiftVerdict.Note] {
            var notes: [SmartShiftVerdict.Note]
            switch forecast {
            case .none: notes = [.connectSolcast(usesHistory: comparison.usesHistory)]
            case .loading: notes = [.forecastState(checkingSolarNote)]
            case .unusable(let message): notes = [.forecastState(message)]
            case .ready: notes = []
            }
            if comparison.hasUnobservedBalance { notes.append(.unobservedBalance) }
            return notes
        }

        var accessibilitySummary: String {
            comparison.lanes.map { lane in
                let period = name(lane.periodKey)
                let start = startLabel(lane.startKwh)
                let nowEnd = spokenBalance(lane.startNow.last?.kwh ?? lane.startKwh)
                if isNow {
                    return "\(period) bank: \(start); \(nowLabel.lowercased()) leaves \(nowEnd)."
                }
                let laterEnd = spokenBalance(lane.recommended.last?.kwh ?? lane.startKwh)
                return "\(period) bank: \(start); \(laterLabel.lowercased()) leaves \(laterEnd), "
                    + "\(nowLabel.lowercased()) leaves \(nowEnd)."
            }.joined(separator: " ")
        }
    }
}
