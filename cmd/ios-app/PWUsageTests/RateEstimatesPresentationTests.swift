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
            == "Your Tesla rate plan may be out of date: newer public rates took effect Jan 1, 2026. "
            + "Check your bill, then change PWUsage’s plan, or update the plan in the Tesla app and sync.")
    }

    @Test func outOfDateNoticeFallsBackWithoutADate() {
        let dto = Self.estimates(teslaPlanOutOfDate: true, newerPlanStart: nil)
        #expect(RateEstimatesPresentation.outOfDateNotice(dto)
            == "Your Tesla rate plan may be out of date. "
            + "Check your bill, then change PWUsage’s plan, or update the plan in the Tesla app and sync.")
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
        #expect(RateEstimatesPresentation.utilityRowValue(Self.estimates()) == "Pacific Gas & Electric")
        #expect(RateEstimatesPresentation.utilityRowValue(Self.estimates(utilityName: nil)) == "Not Set")
        #expect(RateEstimatesPresentation.utilityRowValue(Self.estimates(utilityName: "")) == "Not Set")
    }

    @Test("An unconfirmed or non-US country leads to the country picker, not a US utility search")
    func countryComesBeforeUtility() {
        var unconfirmed = Self.estimates(status: .needsUtility, utilityName: nil)
        unconfirmed.needsCountryConfirmation = true
        unconfirmed.eligibility = .unknown
        #expect(RateEstimatesPresentation.prompt(unconfirmed) == .confirmCountry)
        #expect(RateEstimatesPresentation.utilityRowPrompt(unconfirmed) == .confirmCountry)
        #expect(RateEstimatesPresentation.utilityRowValue(unconfirmed) == "Confirm Country")

        var outside = Self.estimates(status: .skipped, utilityName: nil)
        outside.eligibility = .outsideUS
        #expect(RateEstimatesPresentation.prompt(outside) == nil)
        #expect(RateEstimatesPresentation.utilityRowPrompt(outside) == .confirmCountry)
        #expect(RateEstimatesPresentation.utilityRowValue(outside) == "US Homes Only")

        var american = Self.estimates(status: .needsUtility, utilityName: nil)
        american.eligibility = .unitedStates
        #expect(RateEstimatesPresentation.prompt(american) == .pickUtility)
        #expect(RateEstimatesPresentation.utilityRowPrompt(american) == .pickUtility)
        #expect(RateEstimatesPresentation.buttonTitle(.confirmCountry) == "Confirm Country")
    }

    @Test func accessoryDismissAndAddRatePlanLabels() {
        #expect(RateEstimatesPresentation.notNowLabel == "Not now")
        #expect(RateEstimatesPresentation.addRatePlanButtonTitle == "Add Rate Plan")
    }

    // MARK: Fixed-plan may-be-outdated note and plan picker utility name

    @Test func planPickerUtilityNameFallsBackWithoutAName() {
        #expect(RateEstimatesPresentation.planPickerUtilityName("PG&E") == "PG&E")
        #expect(RateEstimatesPresentation.planPickerUtilityName(nil) == "utility")
        #expect(RateEstimatesPresentation.planPickerUtilityName("") == "utility")
    }

    @Test func fixedPlanNoteShowsWhenOnlyTheReferenceCoversToday() {
        let outdated = Self.estimates(newestRevisionStart: "2026-01-01", mayBeOutdated: true)
        let note = RateEstimatesPresentation.fixedPlanMayBeOutdatedNote(
            outdated,
            referencePeriods: [Self.period(source: .estimated)],
            periods: []
        )
        #expect(note == RateEstimatesPresentation.mayBeOutdatedNote(outdated))
        #expect(note != nil)
    }

    @Test func fixedPlanNoteStaysHiddenWhenAnActualEstimateCoversToday() {
        let outdated = Self.estimates(newestRevisionStart: "2026-01-01", mayBeOutdated: true)
        let note = RateEstimatesPresentation.fixedPlanMayBeOutdatedNote(
            outdated,
            referencePeriods: [Self.period(source: .estimated)],
            periods: [Self.period(source: .estimated)]
        )
        #expect(note == nil)
    }

    @Test func fixedPlanNoteNeedsAnEstimatedReferenceCoveringToday() {
        let outdated = Self.estimates(newestRevisionStart: "2026-01-01", mayBeOutdated: true)
        #expect(RateEstimatesPresentation.fixedPlanMayBeOutdatedNote(
            outdated, referencePeriods: [], periods: []) == nil)
        #expect(RateEstimatesPresentation.fixedPlanMayBeOutdatedNote(
            outdated, referencePeriods: [Self.period(source: .manual)], periods: []) == nil)
    }

    @Test func fixedPlanNoteNeedsTheEstimateToBeMayBeOutdated() {
        let current = Self.estimates(newestRevisionStart: "2026-01-01", mayBeOutdated: false)
        #expect(RateEstimatesPresentation.fixedPlanMayBeOutdatedNote(
            current, referencePeriods: [Self.period(source: .estimated)], periods: []) == nil)
    }

    // MARK: Fixed plan estimate coverage

    private static func reference(
        _ id: Int, from start: String, through end: String?, source: TariffSource = .estimated
    ) -> TariffPeriodDTO {
        TariffPeriodDTO(
            periodId: id, tariffId: id, name: "Residential Rg 1", version: 1, source: source,
            effectiveFrom: start, effectiveTo: end, isCurrentToday: end == nil, updatedBy: nil, seasons: [])
    }

    /// Harrison on Dev: the estimated chain runs from 2018 and history starts 2023-11-14, but the sheet
    /// edits only the 2025-06-01 revision, so it must say the estimate covers every day since history start.
    @Test func estimatedFixedPlanCoverageReachesHistoryStart() {
        let chain = [
            Self.reference(1, from: "2018-01-01", through: "2021-12-31"),
            Self.reference(2, from: "2022-01-01", through: "2023-12-31"),
            Self.reference(3, from: "2024-01-01", through: "2025-05-31"),
            Self.reference(4, from: "2025-06-01", through: nil)
        ]
        #expect(RateEstimatesPresentation.fixedPlanEstimateCoverageNote(
            editing: chain[3], referencePeriods: chain, historyStart: "2023-11-14")
            == "Estimated from public utility rates for every day since Nov 14, 2023. "
            + "Saving your own rates replaces the estimate from the start date.")
    }

    @Test func estimatedFixedPlanCoverageStopsAtOwnerPlan() {
        let periods = [
            Self.reference(1, from: "2023-01-01", through: "2024-06-30", source: .manual),
            Self.reference(2, from: "2024-07-01", through: "2025-05-31"),
            Self.reference(3, from: "2025-06-01", through: nil)
        ]
        #expect(RateEstimatesPresentation.fixedPlanEstimateCoverageNote(
            editing: periods[2], referencePeriods: periods, historyStart: "2023-11-14")
            == "Estimated from public utility rates for every day since Jul 1, 2024. "
            + "Saving your own rates replaces the estimate from the start date.")
    }

    @Test func fixedPlanCoverageNoteIsNilForOwnerPlans() {
        let owner = Self.reference(1, from: "2024-01-01", through: nil, source: .manual)
        #expect(RateEstimatesPresentation.fixedPlanEstimateCoverageNote(
            editing: owner, referencePeriods: [owner], historyStart: "2023-11-14") == nil)
        #expect(RateEstimatesPresentation.fixedPlanEstimateCoverageNote(
            editing: nil, referencePeriods: [], historyStart: nil) == nil)
    }
}
