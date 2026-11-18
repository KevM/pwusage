import Foundation

/// The one setup step a site needs before its days can be priced from public rates.
enum RateEstimatesPrompt: Equatable, Sendable {
    /// The site's country is unconfirmed; public utility rates only cover US homes.
    case confirmCountry
    case pickUtility
    case pickPlan
}

/// Copy for rate plan start-date sources, estimated days and setup prompts.
enum RateEstimatesPresentation {
    private static let updateTail = "Check your bill, then change PWUsage’s plan, "
        + "or update the plan in the Tesla app and sync."

    static func startSourceLabel(_ source: TariffStartSource?) -> String? {
        switch source {
        case .urdb: "From public utility rates"
        case .teslaFirstSeen: "First seen in Tesla"
        case .assumedJan1: "Assumed January 1"
        case .historyStart: "From your first day of data"
        case nil: nil
        }
    }

    static func estimateNote(for period: TariffPeriodDTO) -> String? {
        guard period.source == .estimated else { return nil }
        return "Estimated from public utility rates. Add your rate plan for a better figure."
    }

    static func outOfDateNotice(_ estimates: SiteRateEstimatesDTO?) -> String? {
        guard let estimates, estimates.teslaPlanOutOfDate else { return nil }
        guard let start = estimates.newerPlanStart else {
            return "Your Tesla rate plan may be out of date. \(updateTail)"
        }
        let date = RatePlanTimelineFormatting.displayDate(start)
        return "Your Tesla rate plan may be out of date: newer public rates took effect \(date). \(updateTail)"
    }

    static func mayBeOutdatedNote(_ estimates: SiteRateEstimatesDTO?) -> String? {
        guard let estimates, estimates.mayBeOutdated, let start = estimates.newestRevisionStart else {
            return nil
        }
        let date = RatePlanTimelineFormatting.displayDate(start)
        return "These estimated rates started \(date) and may be out of date. "
            + "Add your rate plan for a better figure."
    }

    static func prompt(_ estimates: SiteRateEstimatesDTO?) -> RateEstimatesPrompt? {
        if estimates?.needsCountryConfirmation == true { return .confirmCountry }
        return switch estimates?.status {
        case .needsUtility: .pickUtility
        case .needsPlan: .pickPlan
        case .pending, .ready, .skipped, .failed, nil: nil
        }
    }

    // MARK: Prompt copy

    static func accessoryTitle(_ prompt: RateEstimatesPrompt) -> String {
        switch prompt {
        case .confirmCountry: "Confirm your home’s country"
        case .pickUtility: "Choose your utility"
        case .pickPlan: "Choose your rate plan"
        }
    }

    static func accessorySubtitle(_ prompt: RateEstimatesPrompt, utilityName: String?) -> String {
        switch prompt {
        case .confirmCountry: "Public utility rates cover US homes"
        case .pickUtility: "To estimate rates for days without a plan"
        case .pickPlan: "\(utilityPhrase(utilityName)) · prices days without a plan"
        }
    }

    static func cardTitle(_ prompt: RateEstimatesPrompt) -> String {
        accessoryTitle(prompt)
    }

    static func cardMessage(_ prompt: RateEstimatesPrompt, utilityName: String?) -> String {
        switch prompt {
        case .confirmCountry:
            "Public utility rates are available for US homes. Confirm your home’s country to use them."
        case .pickUtility:
            "Your utility’s public rates can estimate days without a rate plan."
        case .pickPlan:
            if let name = nonEmpty(utilityName) {
                "Your \(name) plan’s public rates can estimate days without a rate plan."
            } else {
                "Your plan’s public rates can estimate days without a rate plan."
            }
        }
    }

    static func buttonTitle(_ prompt: RateEstimatesPrompt) -> String {
        switch prompt {
        case .confirmCountry: "Confirm Country"
        case .pickUtility: "Choose Utility"
        case .pickPlan: "Choose Rate Plan"
        }
    }

    /// The utility named in the plan picker's copy; `utility` when no name is known.
    static func planPickerUtilityName(_ name: String?) -> String {
        nonEmpty(name) ?? "utility"
    }

    /// The may-be-outdated note for the fixed (reference) plan. Shown only when the reference estimate
    /// covers today and no estimated rate plan does, since Rate Plans already shows that note otherwise.
    static func fixedPlanMayBeOutdatedNote(
        _ estimates: SiteRateEstimatesDTO?,
        referencePeriods: [TariffPeriodDTO],
        periods: [TariffPeriodDTO]
    ) -> String? {
        let referenceCoversToday = referencePeriods.contains { $0.isCurrentToday && $0.source == .estimated }
        let actualCoversToday = periods.contains { $0.isCurrentToday && $0.source == .estimated }
        guard referenceCoversToday, !actualCoversToday else { return nil }
        return mayBeOutdatedNote(estimates)
    }

    /// What an estimated fixed plan covers. The sheet edits one URDB revision (the current one), whose
    /// start date alone reads as if the fixed plan began then; the estimate is a chain of revisions
    /// reaching back to the first day of data, so say how far back the unbroken estimated run goes.
    static func fixedPlanEstimateCoverageNote(
        editing: TariffPeriodDTO?,
        referencePeriods: [TariffPeriodDTO],
        historyStart: String?
    ) -> String? {
        guard let editing, editing.source == .estimated else { return nil }
        let earlier = referencePeriods
            .filter { $0.effectiveFrom < editing.effectiveFrom }
            .sorted { $0.effectiveFrom > $1.effectiveFrom }
        var start = editing.effectiveFrom
        for period in earlier {
            guard period.source == .estimated, let end = period.effectiveTo,
                  RatePlanTimelineFormatting.dayAfter(end) == start else { break }
            start = period.effectiveFrom
        }
        if let historyStart, start < historyStart { start = historyStart }
        return "Estimated from public utility rates for every day since "
            + "\(RatePlanTimelineFormatting.displayDate(start)). "
            + "Saving your own rates replaces the estimate from the start date."
    }

    static let addRatePlanButtonTitle = "Add Rate Plan"
    static let notNowLabel = "Not now"

    /// The Utility row in Rate Plans; `Not Set` until a utility is chosen or skipped.
    static func utilityRowValue(_ estimates: SiteRateEstimatesDTO) -> String {
        if estimates.eligibility == .outsideUS { return "US Homes Only" }
        if estimates.needsCountryConfirmation == true { return "Confirm Country" }
        return nonEmpty(estimates.utilityName) ?? "Not Set"
    }

    /// The utility row asks for the country first while it is unconfirmed, and lets an owner
    /// outside the US correct it, since public utility rates cover only US homes.
    static func addRatePlanTitle(for timeline: SiteTariffsTimelineResponse) -> String {
        timeline.supportsRatePlanSelection ? "Change Plan" : addRatePlanButtonTitle
    }

    static func utilityRowPrompt(_ estimates: SiteRateEstimatesDTO?) -> RateEstimatesPrompt {
        guard let estimates else { return .pickUtility }
        return estimates.needsCountryConfirmation == true || estimates.eligibility == .outsideUS
            ? .confirmCountry : .pickUtility
    }

    private static func utilityPhrase(_ name: String?) -> String {
        nonEmpty(name) ?? "Your utility"
    }

    private static func nonEmpty(_ name: String?) -> String? {
        guard let name, !name.isEmpty else { return nil }
        return name
    }
}
