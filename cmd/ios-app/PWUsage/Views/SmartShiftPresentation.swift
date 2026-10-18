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
        case connectSolcast
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
}

/// Every Smart Shift sentence and display decision, kept out of the views so it can be tested.
enum SmartShiftPresentation {
    /// Prices the Job with the solar forecast when one is ready, otherwise with
    /// balances held still. A forecast comparison that can't run (its stricter
    /// 30-minute balance age, say) falls back to the forecast-free one, and the
    /// card says why in one sentence.
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
        guard let balanceSourceTime else {
            return SmartShiftEvaluation(result: .init(comparison: nil, unavailableReason: .staleBalance), forecast: forecast)
        }
        func run(_ projection: LoadTimingForecastEstimator.Projection) -> LoadTimingForecastEstimator.Result {
            LoadTimingForecastEstimator.evaluate(profile: profile, now: now, timing: timing, projection: projection,
                                                 balanceSourceTime: balanceSourceTime, billingCycleEnd: billingCycleEnd,
                                                 currencyCode: currencyCode)
        }
        var availability = forecast
        if forecast == .ready, let intervals, let context {
            let result = run(.forecast(intervals: intervals, context: context))
            guard let reason = result.unavailableReason else { return SmartShiftEvaluation(result: result, forecast: .ready) }
            availability = .unusable(LoadTimingForecastPresentation.forecastUnavailableNote(reason))
        } else if forecast == .ready {
            availability = .unusable(LoadTimingForecastPresentation.forecastUnavailableNote(.incompleteContext))
        }
        return SmartShiftEvaluation(result: run(.flat(timeZone: timeZone)),
                                    forecast: availability)
    }

    static let connectSolcastNote = "Without a solar forecast, banks are shown as they stand now. Connect Solcast to see today's solar."
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
                              currencyCode: currencyCode, timeZone: timeZone)
        return SmartShiftScreen(content: .verdict(context.verdict(forecast: forecast)))
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
        let currencyCode: String
        let timeZone: String

        var isNow: Bool { comparison.recommendedStart <= comparison.horizonStart }

        var verb: String {
            guard profile.kind != .custom, let first = profile.name.split(separator: " ").first else { return "Start" }
            return String(first)
        }

        var laterLabel: String { "\(verb) later" }
        var nowLabel: String { "\(verb) now" }

        func money(_ amount: Double) -> String { DashboardPresentation.currency(amount, code: currencyCode) }

        /// "4:30 PM", or "4:30 PM tomorrow" when the start falls on a later local day.
        func when(_ date: Date) -> String {
            let clock = DashboardPresentation.date(date, timeZoneIdentifier: timeZone, dateStyle: .none, timeStyle: .short)
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: timeZone) ?? .current
            return calendar.isDate(date, inSameDayAs: now) ? clock : "\(clock) tomorrow"
        }

        func name(_ key: String) -> String {
            timing.tariffTimeline.first { $0.periodKey == key }?.name ?? key
        }

        func periodKey(at date: Date) -> String? {
            timing.tariffTimeline.first { $0.start <= date && date < $0.end }?.periodKey
        }

        /// Period keys a run touches, in the order it reaches them.
        func periods(from start: Date, to end: Date) -> [String] {
            var keys: [String] = []
            for segment in timing.tariffTimeline.sorted(by: { $0.start < $1.start })
            where segment.start < end && segment.end > start && !keys.contains(segment.periodKey) {
                keys.append(segment.periodKey)
            }
            return keys
        }

        func startKwh(_ key: String) -> Double? {
            comparison.lanes.first { $0.periodKey == key }?.startKwh
        }

        func bankPhrase(_ key: String) -> String {
            let kwh = startKwh(key) ?? 0
            return roundedKwh(kwh) > 0 ? "have \(roundedKwh(kwh)) kWh banked" : "have no bank"
        }

        func verdict(forecast: ForecastAvailability) -> SmartShiftVerdict {
            let headline = isNow
                ? "\(profile.name) now: no cheaper time today"
                : "\(profile.name) at \(when(comparison.recommendedStart)): about \(money(comparison.savings)) cheaper than now"
            let nowBar = CostBar(label: nowLabel, amount: money(comparison.costNow), value: comparison.costNow, isRecommended: isNow)
            let bars = isNow
                ? [nowBar]
                : [CostBar(label: laterLabel, amount: money(comparison.recommendedCost), value: comparison.recommendedCost,
                           isRecommended: true), nowBar]
            let lanes = comparison.lanes.map(lane)
            return SmartShiftVerdict(
                headline: headline,
                barsCaption: isNow ? "Added to your bill" : "Added to your bill (shorter is better)",
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
                let before = timing.tariffTimeline.first { $0.end == date }?.name
                let after = timing.tariffTimeline.first { $0.start == date }?.name
                let label = [before.map { "\u{2190} \($0)" }, after.map { "\($0) \u{2192}" }]
                    .compactMap { $0 }.joined(separator: " | ")
                return SwitchMarker(date: date, label: label)
            }
        }

        var axisDates: [Date] {
            let duration = comparison.recommendedEnd.timeIntervalSince(comparison.recommendedStart)
            let ends = [now.addingTimeInterval(duration), comparison.recommendedEnd]
            let dates = Set([now] + ends + comparison.periodSwitches)
            return dates.filter { $0 >= now && $0 <= comparison.horizonEnd }.sorted()
        }

        var percentLess: String? {
            guard !isNow, comparison.costNow > 0 else { return nil }
            let percent = Int(((comparison.costNow - comparison.recommendedCost) / comparison.costNow * 100).rounded())
            return percent > 0 ? "\(percent)% less" : nil
        }

        var why: String {
            if isNow {
                guard let key = periodKey(at: now) else { return "" }
                let period = name(key)
                let bank = startKwh(key) ?? 0
                guard roundedKwh(bank) > 0 else { return "It's \(period); this run is bought at the full rate." }
                let energy = energyKwh(of: profile) ?? 0
                let share = energy <= 0 || bank >= energy ? "all" : bank / energy >= 0.5 ? "most" : "some"
                return "It's \(period), and your \(period) bank covers \(share) of this run."
            }
            let duration = comparison.recommendedEnd.timeIntervalSince(comparison.recommendedStart)
            let nowPeriods = periods(from: now, to: now.addingTimeInterval(duration))
            let laterPeriods = periods(from: comparison.recommendedStart, to: comparison.recommendedEnd)
            guard let first = nowPeriods.first, !laterPeriods.isEmpty else { return "" }
            let time = when(comparison.recommendedStart)
            let laterBanks = banks(laterPeriods)
            if nowPeriods == laterPeriods {
                return "Starting now runs during \(name(first)), where you \(bankPhrase(first)). "
                    + "By \(time), solar adds to your \(laterBanks)."
            }
            if first == laterPeriods.first, let other = nowPeriods.first(where: { !laterPeriods.contains($0) }) {
                return "Starting now runs into \(name(other)), where you \(bankPhrase(other)). "
                    + "Run at \(time) to stay in your \(laterBanks)."
            }
            return "Starting now runs during \(name(first)), where you \(bankPhrase(first)). "
                + "Run at \(time) to use your \(laterBanks)."
        }

        /// "Off-Peak bank", "Peak and Off-Peak banks", "Mid, Peak and Off-Peak banks".
        func banks(_ keys: [String]) -> String {
            let names = keys.map(name)
            guard let last = names.last else { return "bank" }
            let list = names.count == 1 ? last : "\(names.dropLast().joined(separator: ", ")) and \(last)"
            return "\(list) \(names.count == 1 ? "bank" : "banks")"
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
            case .none: notes = [.connectSolcast]
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
