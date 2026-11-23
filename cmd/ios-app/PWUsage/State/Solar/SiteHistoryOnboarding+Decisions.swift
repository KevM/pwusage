import Foundation
import PWUsageCore

/// The checkpoint rules live in `SiteHistoryCheckpoints`; these read them against stored progress.
extension SiteHistoryOnboarding {
    typealias Target = SiteHistoryCheckpoints.Target

    static func sortDue(_ progress: SiteHistoryOnboardingProgress, checked: Int) -> Bool {
        SiteHistoryCheckpoints.sortDue(checked: checked, sortedCheckedDays: progress.sortedCheckedDays)
    }

    static func detectionDue(
        _ days: SolarDayClassification, progress: SiteHistoryOnboardingProgress, checked: Int
    ) -> Bool {
        SiteHistoryCheckpoints.detectionDue(
            days, checked: checked, lastAssessedCheckedDays: progress.lastAssessedCheckedDays,
            detectedTargets: progress.detectedTargets
        )
    }

    static func finishReason(_ result: DetectedSolarLayout, atBound: Bool) -> FinishReason? {
        SiteHistoryCheckpoints.finishReason(result, atBound: atBound)
    }
}
