import Foundation
@testable import PWUsageCore
import Testing

@Suite("Site history checkpoints")
struct SiteHistoryCheckpointsTests {
    typealias Target = SiteHistoryCheckpoints.Target

    /// `clear` clear days and `cloudy` more producing days.
    private static func days(clear: Int, cloudy: Int = 0) -> SolarDayClassification {
        var days: [String: SolarDayType] = [:]
        for index in 0 ..< clear { days["c\(index)"] = .clear }
        for index in 0 ..< cloudy { days["o\(index)"] = .cloudy }
        return SolarDayClassification(days: days)
    }

    private static func result(
        _ status: DetectedSolarLayout.Status, _ confidence: String?, reasons: [String] = [],
        shortfall: DetectedSolarLayout.Shortfall? = nil
    ) -> DetectedSolarLayout {
        DetectedSolarLayout(
            status: status, confidence: confidence, reasons: reasons, planes: [], acClipKw: nil,
            historyDays: 60, clearDays: 10, firstDay: nil, lastDay: nil, shortfall: shortfall)
    }

    // MARK: - Targets

    @Test("Targets are reached at 15 and 40 clear days and 180 producing days")
    func targetThresholds() {
        #expect(Target.reached(producingDays: 179, clearDays: 14).isEmpty)
        #expect(Target.reached(producingDays: 0, clearDays: 15) == [.clear15])
        #expect(Target.reached(producingDays: 0, clearDays: 40) == [.clear15, .clear40])
        #expect(Target.reached(producingDays: 180, clearDays: 0) == [.producing180])
    }

    @Test("Targets keep the raw values stored in onboarding progress")
    func targetRawValues() {
        #expect([Target.clear15, .clear40, .producing180].map(\.rawValue) == ["clear15", "clear40", "producing180"])
    }

    // MARK: - Clear-day pass

    @Test("The clear-day pass is due once six checked days are unsorted")
    func sortDue() {
        #expect(!SiteHistoryCheckpoints.sortDue(checked: 5, sortedCheckedDays: nil))
        #expect(SiteHistoryCheckpoints.sortDue(checked: 6, sortedCheckedDays: nil))
        #expect(!SiteHistoryCheckpoints.sortDue(checked: 23, sortedCheckedDays: 18))
        #expect(SiteHistoryCheckpoints.sortDue(checked: 24, sortedCheckedDays: 18))
    }

    // MARK: - Full detection

    @Test("Detection waits for the detector's producing-day minimum")
    func detectionNeedsMinimumHistory() {
        let short = Self.days(clear: 20, cloudy: SolarLayoutDetector.minHistoryDays - 21)
        #expect(!SiteHistoryCheckpoints.detectionDue(
            short, checked: 200, lastAssessedCheckedDays: 0, detectedTargets: nil))
    }

    @Test("Detection runs when a new target is reached, and not again until one is or 30 days pass")
    func detectionOnNewTargetOrReassessment() {
        let days = Self.days(clear: 15, cloudy: SolarLayoutDetector.minHistoryDays)
        #expect(SiteHistoryCheckpoints.detectionDue(
            days, checked: 60, lastAssessedCheckedDays: 0, detectedTargets: nil))
        #expect(!SiteHistoryCheckpoints.detectionDue(
            days, checked: 60, lastAssessedCheckedDays: 60, detectedTargets: [.clear15]))
        #expect(!SiteHistoryCheckpoints.detectionDue(
            days, checked: 89, lastAssessedCheckedDays: 60, detectedTargets: [.clear15]))
        #expect(SiteHistoryCheckpoints.detectionDue(
            days, checked: 90, lastAssessedCheckedDays: 60, detectedTargets: [.clear15]))
        let more = Self.days(clear: 40, cloudy: SolarLayoutDetector.minHistoryDays)
        #expect(SiteHistoryCheckpoints.detectionDue(
            more, checked: 61, lastAssessedCheckedDays: 60, detectedTargets: [.clear15]))
    }

    // MARK: - Finish

    @Test("High confidence ends the search; a usable medium layout ends it only at the bound")
    func usableLayouts() {
        #expect(SiteHistoryCheckpoints.finishReason(Self.result(.detected, "high"), atBound: false) == .layoutFound)
        #expect(SiteHistoryCheckpoints.finishReason(Self.result(.detected, "medium"), atBound: false) == nil)
        #expect(SiteHistoryCheckpoints.finishReason(Self.result(.detected, "medium"), atBound: true) == .layoutFound)
    }

    @Test("A problem more history will not fix ends the search; one it may fix does not")
    func unusableLayouts() {
        let fixable = Self.result(.lowConfidence, "low", reasons: ["few-clear-days"])
        #expect(SiteHistoryCheckpoints.finishReason(fixable, atBound: false) == nil)
        #expect(SiteHistoryCheckpoints.finishReason(fixable, atBound: true) == nil)
        let mismatch = Self.result(.lowConfidence, "low", reasons: ["location-mismatch"])
        #expect(SiteHistoryCheckpoints.finishReason(mismatch, atBound: false) == .detectorNeedsOtherAction)
    }

    @Test("Finish reasons keep the raw values stored in onboarding progress")
    func finishReasonRawValues() {
        let all: [SiteHistoryFinishReason] = [
            .layoutFound, .layoutAlreadyUsable, .reachedHistoryStart, .reachedOneYear,
            .noSolarProduction, .locationNeeded, .detectorNeedsOtherAction, .historyUnavailable
        ]
        #expect(all.map(\.rawValue) == [
            "layoutFound", "layoutAlreadyUsable", "reachedHistoryStart", "reachedOneYear",
            "noSolarProduction", "locationNeeded", "detectorNeedsOtherAction", "historyUnavailable"
        ])
    }
}
