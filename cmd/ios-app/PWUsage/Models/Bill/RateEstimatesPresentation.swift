import Foundation

/// The one setup step a site needs before its days can be priced from public rates.
enum RateEstimatesPrompt: Equatable, Sendable {
    case pickUtility
    case pickPlan
}

/// Copy for rate plan start-date sources, estimated days and setup prompts.
enum RateEstimatesPresentation {
    private static let updateTail = "Update it in the Tesla app or add your rate plan here."

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
            return "Your Tesla rate plan looks out of date. \(updateTail)"
        }
        let date = RatePlanTimelineFormatting.displayDate(start)
        return "Your Tesla rate plan looks out of date. Newer rates took effect \(date). \(updateTail)"
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
        switch estimates?.status {
        case .needsUtility: .pickUtility
        case .needsPlan: .pickPlan
        case .pending, .ready, .skipped, .failed, nil: nil
        }
    }

    // MARK: Prompt copy

    static func accessoryTitle(_ prompt: RateEstimatesPrompt) -> String {
        switch prompt {
        case .pickUtility: "Choose your utility"
        case .pickPlan: "Choose your rate plan"
        }
    }

    static func accessorySubtitle(_ prompt: RateEstimatesPrompt, utilityName: String?) -> String {
        switch prompt {
        case .pickUtility: "To estimate rates for days without a plan"
        case .pickPlan: "\(utilityPhrase(utilityName)) · prices days without a plan"
        }
    }

    static func cardTitle(_ prompt: RateEstimatesPrompt) -> String {
        accessoryTitle(prompt)
    }

    static func cardMessage(_ prompt: RateEstimatesPrompt, utilityName: String?) -> String {
        switch prompt {
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
        case .pickUtility: "Choose Utility"
        case .pickPlan: "Choose Rate Plan"
        }
    }

    static let addRatePlanButtonTitle = "Add Rate Plan"
    static let notNowLabel = "Not now"

    /// The Utility row in Rate Plans; `Not Set` until a utility is chosen or skipped.
    static func utilityRowValue(_ name: String?) -> String {
        nonEmpty(name) ?? "Not Set"
    }

    private static func utilityPhrase(_ name: String?) -> String {
        nonEmpty(name) ?? "Your utility"
    }

    private static func nonEmpty(_ name: String?) -> String? {
        guard let name, !name.isEmpty else { return nil }
        return name
    }
}
