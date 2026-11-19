import Foundation

/// Labels for where a plan came from, who chose it and who verified it. The three are separate:
/// a public plan an owner chose and verified still reads as public rates.
enum RatePlanSourcePresentation {
    static func sourceLabel(
        _ source: TariffSource,
        candidateKind: TariffSelectionCandidateKind? = nil
    ) -> String {
        if candidateKind == .aiHandoff {
            return "Imported with AI assistant"
        }
        switch source {
        case .tesla: return "From Tesla"
        case .estimated: return "From public utility rates"
        case .manual: return "Entered by you"
        }
    }

    /// Nil from older servers that don't record who chose a plan.
    static func chooserLabel(
        _ choiceKind: TariffSelectionChoiceKind?,
        updatedBy: TariffUpdatedByDTO?
    ) -> String? {
        switch choiceKind {
        case .automatic: "Chosen automatically"
        case .owner: "Chosen by \(person(isCurrentUser: updatedBy?.isCurrentUser, email: updatedBy?.email))"
        case nil: nil
        }
    }

    /// Someone else's verification never reads as the viewer's own.
    static func verificationLabel(_ verification: TariffVerificationSummary?) -> String? {
        guard let verification else { return nil }
        let verifier = person(isCurrentUser: verification.verifiedByCurrentUser, email: verification.verifiedByEmail)
        return "Verified by \(verifier)"
    }

    /// An owner's override with a selection record can be put back to the Tesla plan it replaced;
    /// the review says if no Tesla original was saved for the chosen dates.
    static func canRestoreTesla(_ period: TariffPeriodDTO, in timeline: SiteTariffsTimelineResponse) -> Bool {
        timeline.supportsRatePlanSelection && period.choiceKind == .owner && period.source != .tesla
            && period.selectionId != nil && timeline.periods.contains { $0.periodId == period.periodId }
    }

    /// Public plans are offered for a US site with a chosen utility.
    static func offersPublicPlans(_ timeline: SiteTariffsTimelineResponse) -> Bool {
        let eligible = timeline.rateCountry?.eligibility == .unitedStates
            || timeline.estimates?.eligibility == .unitedStates
        return eligible && !(timeline.estimates?.utilityName ?? "").isEmpty
    }

    private static func person(isCurrentUser: Bool?, email: String?) -> String {
        if isCurrentUser == true { return "you" }
        if let email, !email.isEmpty { return email }
        return "a household member"
    }
}

/// Copy for the review an owner sees before a rate plan change applies.
enum RatePlanReviewPresentation {
    static let restoreActionTitle = "Restore Original Tesla Rate Plan"
    static let acknowledgementLabel = "I reviewed these changes"
    static let verificationLabel = "I checked these details against my utility bill"
    static let powerwallWarning = "This changes the rates PWUsage uses for bills and savings estimates. "
        + "Your Powerwall will continue using the plan saved in Tesla. Check the prices, time periods, "
        + "export rates, and effective date against your utility bill."
    static let referenceNote = "This changes only the fixed comparison plan used for savings. "
        + "The rates for your energy and your Powerwall don't change."
    static let refreshedNotice = "Your rate plans changed since you opened this review. "
        + "Check the updated comparison before applying it."

    static func rangeLabel(from start: String, to end: String?) -> String {
        let first = RatePlanTimelineFormatting.displayDate(start)
        guard let end else { return "From \(first), ongoing" }
        return start == end ? first : "\(first) – \(RatePlanTimelineFormatting.displayDate(end))"
    }

    static func recalculationNote(_ preview: TariffSelectionPreviewResponse) -> String {
        guard preview.recalculatesHistory, let range = preview.recalculationRange else {
            return "No past bills or savings change."
        }
        if preview.recalculatesFromHistoryStart {
            return "All past bills and savings estimates will be recalculated in the background."
        }
        let start = RatePlanTimelineFormatting.displayDate(range.fromDate)
        return "Bills and savings estimates from \(start) will be recalculated in the background."
    }

    static func intervalHeadline(_ interval: TariffReviewAffectedInterval) -> String {
        switch interval.kind {
        case .fillGap: "Adds a plan where there was none"
        case .replace: "Replaces \(interval.before?.name ?? "the current plan")"
        case .restore: "Restores the saved Tesla plan"
        case .restoreUnavailable: "No saved Tesla plan for these dates"
        }
    }

    /// Restoring writes only dates with a saved Tesla plan; the rest keep their current plan.
    static func keepsPlanLine(_ interval: TariffReviewAffectedInterval) -> String? {
        guard interval.kind == .restoreUnavailable else { return nil }
        guard let name = interval.before?.name else { return "These dates stay without a plan." }
        return "\(name) stays for these dates."
    }

    /// Unchanged dates have no before and after to compare.
    static func comparesRates(_ interval: TariffReviewAffectedInterval) -> Bool {
        interval.kind != .restoreUnavailable
    }

    /// Why a gap shows a plan under Before: billing borrows it for days without a plan.
    static func fallbackNote(_ interval: TariffReviewAffectedInterval) -> String? {
        guard interval.beforeIsFallback, let name = interval.before?.name else { return nil }
        return "These dates have no plan of their own, so bills use \(name) for them now."
    }

    static func restorationNote(_ restoration: TariffIntervalRestorationProvenance) -> String? {
        switch restoration {
        case .notApplicable: nil
        case .preservesTeslaOriginal(let original):
            "\(original.name) from Tesla is kept, so you can restore it later."
        case .restoringOriginal(let original):
            "Restores \(original.name), the Tesla plan saved for these dates."
        case .unavailable(let reason): reason
        }
    }

    /// Exact boundaries, to the minute: Tesla schedules can change at times like 6:07.
    static func timeLabel(_ row: TariffAlignedTimeRow) -> String {
        let startsAtMidnight = row.fromHour == 0 && row.fromMinute == 0
        let endsAtMidnight = (row.toHour == 24 || row.toHour == 0) && row.toMinute == 0
        if startsAtMidnight, endsAtMidnight { return "All day" }
        return "\(clockTime(hour: row.fromHour, minute: row.fromMinute)) – "
            + clockTime(hour: row.toHour, minute: row.toMinute)
    }

    private static func clockTime(hour: Int, minute: Int) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        let components = DateComponents(year: 2000, month: 1, day: 1, hour: hour % 24, minute: minute)
        guard let date = calendar.date(from: components) else { return "\(hour):\(minute)" }
        let style = Date.FormatStyle(locale: Locale(identifier: "en_US"), calendar: calendar, timeZone: .gmt)
            .hour(.defaultDigits(amPM: .abbreviated))
            .minute(.twoDigits)
        // Match the app's other time labels, which use a plain space before AM/PM.
        return date.formatted(style).replacingOccurrences(of: "\u{202F}", with: " ")
    }

    static func seasonLabel(_ season: TariffAlignedSeasonComparison) -> String {
        let names = [season.beforeSeasonName, season.afterSeasonName].compactMap(\.self)
        let name = names.first == names.last ? names.first ?? "" : names.joined(separator: " → ")
        let dates = "\(RatePlanTimelineFormatting.monthAbbreviation(season.fromMonth)) \(season.fromDay) – "
            + "\(RatePlanTimelineFormatting.monthAbbreviation(season.toMonth)) \(season.toDay)"
        return name.isEmpty ? dates : "\(name) · \(dates)"
    }

    /// "Peak $0.30 → Off-Peak $0.12", or "None" for a side with no rate.
    static func rateChange(
        before: TariffComparisonSlotRate?,
        after: TariffComparisonSlotRate?,
        rate: KeyPath<TariffComparisonSlotRate, Double>,
        currency: String
    ) -> String {
        func side(_ slot: TariffComparisonSlotRate?) -> String {
            guard let slot else { return "None" }
            return "\(slot.touName.displayName) \(RateFormatting.formatRate(slot[keyPath: rate], currency: currency))"
        }
        let old = side(before)
        let new = side(after)
        return old == new ? new : "\(old) → \(new)"
    }
}
