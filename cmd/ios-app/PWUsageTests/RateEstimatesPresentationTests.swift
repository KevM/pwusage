import Foundation
@testable import PWUsage
import Testing

struct RateEstimatesPresentationTests {
    private static func estimates(
        status: SiteRateEstimatesDTO.Status = .ready,
        utilityName: String? = "Pacific Gas & Electric",
        teslaPlanOutOfDate: Bool = false,
        newerPlanStart: String? = nil,
        newestRevisionStart: String? = nil,
        mayBeOutdated: Bool = false
    ) -> SiteRateEstimatesDTO {
        SiteRateEstimatesDTO(
            status: status,
            utilityName: utilityName,
            teslaPlanOutOfDate: teslaPlanOutOfDate,
            newerPlanName: nil,
            newerPlanStart: newerPlanStart,
            newestRevisionStart: newestRevisionStart,
            mayBeOutdated: mayBeOutdated
        )
    }

    private static func period(source: TariffSource) -> TariffPeriodDTO {
        TariffPeriodDTO(
            periodId: 1,
            tariffId: 1,
            name: "Estimated",
            version: 1,
            source: source,
            effectiveFrom: "2026-01-01",
            effectiveTo: nil,
            isCurrentToday: true,
            updatedBy: nil,
            seasons: []
        )
    }

    // MARK: Start-date source labels

    @Test func startSourceLabelsNameEachSource() {
        #expect(RateEstimatesPresentation.startSourceLabel(.urdb) == "From public utility rates")
        #expect(RateEstimatesPresentation.startSourceLabel(.teslaFirstSeen) == "First seen in Tesla")
        #expect(RateEstimatesPresentation.startSourceLabel(.assumedJan1) == "Assumed January 1")
        #expect(RateEstimatesPresentation.startSourceLabel(.historyStart) == "From your first day of data")
    }

    @Test func startSourceLabelIsNilWithoutSource() {
        #expect(RateEstimatesPresentation.startSourceLabel(nil) == nil)
    }

    // MARK: Estimate note

    @Test func estimateNoteAppearsOnlyForEstimatedPeriods() {
        let note = "Estimated from public utility rates. Add your rate plan for a better figure."
        #expect(RateEstimatesPresentation.estimateNote(for: Self.period(source: .estimated)) == note)
        #expect(RateEstimatesPresentation.estimateNote(for: Self.period(source: .tesla)) == nil)
        #expect(RateEstimatesPresentation.estimateNote(for: Self.period(source: .manual)) == nil)
    }

    // MARK: Out-of-date notice

    @Test func outOfDateNoticeNamesTheNewerRevisionStart() {
        let dto = Self.estimates(teslaPlanOutOfDate: true, newerPlanStart: "2026-01-01")
        #expect(RateEstimatesPresentation.outOfDateNotice(dto)
            == "Your Tesla rate plan looks out of date. Newer rates took effect Jan 1, 2026. "
            + "Update it in the Tesla app or add your rate plan here.")
    }

    @Test func outOfDateNoticeFallsBackWithoutADate() {
        let dto = Self.estimates(teslaPlanOutOfDate: true, newerPlanStart: nil)
        #expect(RateEstimatesPresentation.outOfDateNotice(dto)
            == "Your Tesla rate plan looks out of date. Update it in the Tesla app or add your rate plan here.")
    }

    @Test func outOfDateNoticeIsHiddenWhenThePlanIsCurrent() {
        let dto = Self.estimates(teslaPlanOutOfDate: false, newerPlanStart: "2026-01-01")
        #expect(RateEstimatesPresentation.outOfDateNotice(dto) == nil)
        #expect(RateEstimatesPresentation.outOfDateNotice(nil) == nil)
    }

    // MARK: May-be-outdated note

    @Test func mayBeOutdatedNoteNamesTheNewestRevisionStart() {
        let dto = Self.estimates(newestRevisionStart: "2026-03-15", mayBeOutdated: true)
        #expect(RateEstimatesPresentation.mayBeOutdatedNote(dto)
            == "These estimated rates started Mar 15, 2026 and may be out of date. "
            + "Add your rate plan for a better figure.")
    }

    @Test func mayBeOutdatedNoteNeedsADateAndTheFlag() {
        #expect(RateEstimatesPresentation.mayBeOutdatedNote(
            Self.estimates(newestRevisionStart: nil, mayBeOutdated: true)) == nil)
        #expect(RateEstimatesPresentation.mayBeOutdatedNote(
            Self.estimates(newestRevisionStart: "2026-03-15", mayBeOutdated: false)) == nil)
        #expect(RateEstimatesPresentation.mayBeOutdatedNote(nil) == nil)
    }

    // MARK: Prompts

    @Test func promptFollowsTheSetupStatus() {
        #expect(RateEstimatesPresentation.prompt(Self.estimates(status: .needsUtility)) == .pickUtility)
        #expect(RateEstimatesPresentation.prompt(Self.estimates(status: .needsPlan)) == .pickPlan)
        #expect(RateEstimatesPresentation.prompt(Self.estimates(status: .ready)) == nil)
        #expect(RateEstimatesPresentation.prompt(Self.estimates(status: .pending)) == nil)
        #expect(RateEstimatesPresentation.prompt(Self.estimates(status: .skipped)) == nil)
        #expect(RateEstimatesPresentation.prompt(Self.estimates(status: .failed)) == nil)
        #expect(RateEstimatesPresentation.prompt(nil) == nil)
    }

    @Test func pickUtilityCopy() {
        let prompt = RateEstimatesPrompt.pickUtility
        #expect(RateEstimatesPresentation.accessoryTitle(prompt) == "Choose your utility")
        #expect(RateEstimatesPresentation.accessorySubtitle(prompt, utilityName: nil)
            == "To estimate rates for days without a plan")
        #expect(RateEstimatesPresentation.cardTitle(prompt) == "Choose your utility")
        #expect(RateEstimatesPresentation.cardMessage(prompt, utilityName: nil)
            == "Your utility’s public rates can estimate days without a rate plan.")
        #expect(RateEstimatesPresentation.buttonTitle(prompt) == "Choose Utility")
    }

    @Test func pickPlanCopyNamesTheUtility() {
        let prompt = RateEstimatesPrompt.pickPlan
        #expect(RateEstimatesPresentation.accessoryTitle(prompt) == "Choose your rate plan")
        #expect(RateEstimatesPresentation.accessorySubtitle(prompt, utilityName: "PG&E")
            == "PG&E · prices days without a plan")
        #expect(RateEstimatesPresentation.cardTitle(prompt) == "Choose your rate plan")
        #expect(RateEstimatesPresentation.cardMessage(prompt, utilityName: "PG&E")
            == "Your PG&E plan’s public rates can estimate days without a rate plan.")
        #expect(RateEstimatesPresentation.buttonTitle(prompt) == "Choose Rate Plan")
    }

    @Test func pickPlanCopyFallsBackWithoutAUtilityName() {
        let prompt = RateEstimatesPrompt.pickPlan
        #expect(RateEstimatesPresentation.accessorySubtitle(prompt, utilityName: nil)
            == "Your utility · prices days without a plan")
        #expect(RateEstimatesPresentation.cardMessage(prompt, utilityName: nil)
            == "Your plan’s public rates can estimate days without a rate plan.")
    }

    // MARK: Rate Plans and accessory copy

    @Test func utilityRowShowsTheNameOrNotSet() {
        #expect(RateEstimatesPresentation.utilityRowValue("Pacific Gas & Electric") == "Pacific Gas & Electric")
        #expect(RateEstimatesPresentation.utilityRowValue(nil) == "Not Set")
        #expect(RateEstimatesPresentation.utilityRowValue("") == "Not Set")
    }

    @Test func accessoryDismissAndAddRatePlanLabels() {
        #expect(RateEstimatesPresentation.notNowLabel == "Not now")
        #expect(RateEstimatesPresentation.addRatePlanButtonTitle == "Add Rate Plan")
    }
}
