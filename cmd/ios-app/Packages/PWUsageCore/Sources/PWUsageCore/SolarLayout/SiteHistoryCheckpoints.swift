#if canImport(FoundationEssentials)
    import FoundationEssentials
#else
    import Foundation
#endif

/// Why a site's history onboarding stopped reaching back. Stored in onboarding progress by raw value.
public enum SiteHistoryFinishReason: String, Codable, Sendable {
    case layoutFound, layoutAlreadyUsable, reachedHistoryStart, reachedOneYear
    case noSolarProduction, locationNeeded, detectorNeedsOtherAction, historyUnavailable
}

/// The onboarding checkpoint rules: which targets run detection, when it is due, and which results
/// end the search.
public enum SiteHistoryCheckpoints {
    public static let reassessEveryDays = 30
    /// Unsorted checked days that run the clear-day pass: two slices' worth.
    public static let sortEveryDays = 6

    /// Targets whose first crossing runs full detection. Stored in onboarding progress by raw value.
    public enum Target: String, Codable, Sendable {
        case clear15, clear40, producing180

        public static func reached(producingDays: Int, clearDays: Int) -> Set<Target> {
            var targets: Set<Target> = []
            if clearDays >= 15 { targets.insert(.clear15) }
            if clearDays >= 40 { targets.insert(.clear40) }
            if producingDays >= 180 { targets.insert(.producing180) }
            return targets
        }
    }

    /// The clear-day pass is due once enough checked days are unsorted. A pass that was cut off
    /// leaves them unsorted, so the next slice runs it again.
    public static func sortDue(checked: Int, sortedCheckedDays: Int?) -> Bool {
        checked - (sortedCheckedDays ?? 0) >= sortEveryDays
    }

    /// Full detection once the detector's producing-day minimum is met, when a target was reached
    /// since the last run, or 30 checked days after it.
    public static func detectionDue(
        _ days: SolarDayClassification, checked: Int, lastAssessedCheckedDays: Int, detectedTargets: [Target]?
    ) -> Bool {
        guard days.producingDays >= SolarLayoutDetector.minHistoryDays else { return false }
        let reached = Target.reached(producingDays: days.producingDays, clearDays: days.clearDays)
        return !reached.isSubset(of: Set(detectedTargets ?? []))
            || checked - lastAssessedCheckedDays >= reassessEveryDays
    }

    /// High confidence ends the search; so does a usable layout at the bound, and a problem more
    /// history will not fix.
    public static func finishReason(_ result: DetectedSolarLayout, atBound: Bool) -> SiteHistoryFinishReason? {
        switch SolarLayoutDetector.historyOutlook(result) {
        case .usable: atBound || result.confidence == SolarLayoutConfidence.high.rawValue ? .layoutFound : nil
        case .needsOtherAction: .detectorNeedsOtherAction
        case .moreHistoryMayHelp: nil
        }
    }
}
