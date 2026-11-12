import Foundation
@testable import PWUsage
import Testing

@Suite("Site history presentation, configured")
struct SiteHistoryPresentationConfiguredTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-1")
    private let now = Date(timeIntervalSince1970: 1_793_642_400)

    private var detected: DetectedSolarLayout {
        DetectedSolarLayout(
            status: .detected, confidence: "high", reasons: [],
            planes: [.init(
                azimuth: 180, tilt: 22, dcKwp: 6, effectiveKw: 5.1, azimuthRange90: [170, 190], tiltRange90: [20, 24])],
            acClipKw: nil, historyDays: 365, clearDays: 80, firstDay: nil, lastDay: nil)
    }

    private func presentation(hasManualLayout: Bool, found: Bool = true) -> SiteHistoryPresentation {
        var progress = SiteHistoryOnboardingProgress(checkedUntil: "2026-11-02")
        progress.phase = .finished(.layoutFound)
        return SiteHistoryPresentation(
            status: SiteHistoryStatus(
                scope: scope, progress: progress, throttledUntil: nil, result: found ? detected : nil),
            now: now, hasManualLayout: hasManualLayout)
    }

    @Test("A system found automatically says Found")
    func foundAutomatically() {
        #expect(presentation(hasManualLayout: false).rowValue == "Found")
    }

    @Test("A system the owner edited says Configured")
    func configuredByTheOwner() {
        #expect(presentation(hasManualLayout: true).rowValue == "Configured")
    }

    @Test("Entered panels say Configured even when nothing was found")
    func configuredWithoutADetection() {
        #expect(presentation(hasManualLayout: true, found: false).rowValue == "Configured")
    }

    @Test("Entered panels change only the Settings row, not the status line or banner")
    func onlyTheRowChanges() {
        let plain = presentation(hasManualLayout: false)
        let configured = presentation(hasManualLayout: true)
        #expect(configured.statusLine == plain.statusLine)
        #expect(configured.showsBanner == plain.showsBanner)
        #expect(configured.phase == plain.phase)
    }
}
