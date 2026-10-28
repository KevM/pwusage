import Foundation

extension SmartShiftPresentation {
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
                balance: timing.hasCycleData ? balanceLabel(period.cycleNetExportKwh) : "No bank yet"
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

    // MARK: - Blocked states

    static func blockedMessage(profile: LoadProfile, result: LoadTimingForecastEstimator.Result,
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
    static func spokenBalance(_ kwh: Double) -> String {
        let value = roundedKwh(kwh)
        if value > 0 { return "\(value) kWh banked" }
        if value < 0 { return "\(-value) kWh owed" }
        return "0 kWh"
    }

    static func roundedKwh(_ kwh: Double) -> Int {
        guard kwh.isFinite else { return 0 }
        return Int(kwh.rounded())
    }

    // MARK: - Verdict
}
