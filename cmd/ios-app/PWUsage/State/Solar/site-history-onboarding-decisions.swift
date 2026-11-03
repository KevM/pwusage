import Foundation

/// The checkpoint rules: which targets run detection, when it is due, and which results end the search.
extension SiteHistoryOnboarding {
    /// Targets whose first crossing runs full detection.
    enum Target: String, Codable, Sendable {
        case clear15, clear40, producing180

        static func reached(producingDays: Int, clearDays: Int) -> Set<Target> {
            var targets: Set<Target> = []
            if clearDays >= 15 { targets.insert(.clear15) }
            if clearDays >= 40 { targets.insert(.clear40) }
            if producingDays >= 180 { targets.insert(.producing180) }
            return targets
        }
    }

    /// The clear-day pass is due once enough checked days are unsorted. A pass that was cut off
    /// leaves them unsorted, so the next slice runs it again.
    static func sortDue(_ progress: SiteHistoryOnboardingProgress, checked: Int) -> Bool {
        checked - (progress.sortedCheckedDays ?? 0) >= sortEveryDays
    }

    /// Full detection once the detector's producing-day minimum is met, when a target was reached
    /// since the last run, or 30 checked days after it.
    static func detectionDue(
        _ days: SolarDayClassification, progress: SiteHistoryOnboardingProgress, checked: Int
    ) -> Bool {
        guard days.producingDays >= SolarLayoutDetector.minHistoryDays else { return false }
        let reached = Target.reached(producingDays: days.producingDays, clearDays: days.clearDays)
        return !reached.isSubset(of: Set(progress.detectedTargets ?? []))
            || checked - progress.lastAssessedCheckedDays >= reassessEveryDays
    }

    /// High confidence ends the search; so does a usable layout at the bound, and a problem more
    /// history will not fix.
    static func finishReason(_ result: DetectedSolarLayout, atBound: Bool) -> FinishReason? {
        switch SolarLayoutDetector.historyOutlook(result) {
        case .usable: atBound || result.confidence == SolarLayoutConfidence.high.rawValue ? .layoutFound : nil
        case .needsOtherAction: .detectorNeedsOtherAction
        case .moreHistoryMayHelp: nil
        }
    }
}
