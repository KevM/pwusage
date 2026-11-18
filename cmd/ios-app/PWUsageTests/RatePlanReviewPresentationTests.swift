import Foundation
@testable import PWUsage
import Testing

@Suite("Rate plan source, chooser, verification and review copy")
struct RatePlanReviewPresentationTests {
    private static func timeline(
        country: SiteRateCountryDTO?,
        utility: String? = "We Energies",
        periods: [TariffPeriodDTO] = []
    ) -> SiteTariffsTimelineResponse {
        SiteTariffsTimelineResponse(
            version: 2, siteId: "site-1", timezone: "America/Chicago", currency: "USD", periods: periods,
            reattribution: nil,
            teslaSync: TeslaSyncDTO(
                latestTariffId: nil, latestTariffName: nil, latestUpdatedAt: nil,
                activeManualUpdatedAt: nil, differsFromActiveManual: false
            ),
            estimates: SiteRateEstimatesDTO(
                status: .ready, utilityName: utility, teslaPlanOutOfDate: false, newerPlanName: nil,
                newerPlanStart: nil, newestRevisionStart: nil, mayBeOutdated: false
            ),
            rateCountry: country
        )
    }

    private static let unitedStates = SiteRateCountryDTO(
        countryCode: "US", source: .owner, updatedAt: nil, eligibility: .unitedStates
    )

    private static func period(source: TariffSource, choice: TariffSelectionChoiceKind?) -> TariffPeriodDTO {
        TariffPeriodDTO(
            periodId: 5, tariffId: 9, name: "Override", version: 1, source: source,
            effectiveFrom: "2025-01-01", effectiveTo: nil, isCurrentToday: true, updatedBy: nil, seasons: [],
            selectionId: 21, choiceKind: choice
        )
    }

    @Test("Source, chooser and verifier are separate, and another member's check isn't yours")
    func labels() {
        #expect(RatePlanSourcePresentation.sourceLabel(.tesla) == "From Tesla")
        #expect(RatePlanSourcePresentation.sourceLabel(.estimated) == "From public utility rates")
        #expect(RatePlanSourcePresentation.sourceLabel(.manual) == "Entered by you")
        #expect(RatePlanSourcePresentation.chooserLabel(.automatic, updatedBy: nil) == "Chosen automatically")
        #expect(RatePlanSourcePresentation.chooserLabel(
            .owner, updatedBy: TariffUpdatedByDTO(email: nil, isCurrentUser: true)
        ) == "Chosen by you")
        #expect(RatePlanSourcePresentation.chooserLabel(nil, updatedBy: nil) == nil)
        let mine = TariffVerificationSummary(verifiedAt: "x", verifiedByEmail: "me@x", verifiedByCurrentUser: true)
        let theirs = TariffVerificationSummary(verifiedAt: "x", verifiedByEmail: "pat@x", verifiedByCurrentUser: false)
        let unknown = TariffVerificationSummary(verifiedAt: "x", verifiedByEmail: nil, verifiedByCurrentUser: false)
        #expect(RatePlanSourcePresentation.verificationLabel(mine) == "Verified by you")
        #expect(RatePlanSourcePresentation.verificationLabel(theirs) == "Verified by pat@x")
        #expect(RatePlanSourcePresentation.verificationLabel(unknown) == "Verified by a household member")
    }

    @Test("Restore appears only for an owner's override on a server that supports it")
    func restoreAvailability() {
        let override = Self.period(source: .estimated, choice: .owner)
        let withOverride = Self.timeline(country: Self.unitedStates, periods: [override])
        #expect(RatePlanSourcePresentation.canRestoreTesla(override, in: withOverride))
        let automatic = Self.period(source: .estimated, choice: .automatic)
        let automaticTimeline = Self.timeline(country: Self.unitedStates, periods: [automatic])
        #expect(!RatePlanSourcePresentation.canRestoreTesla(automatic, in: automaticTimeline))
        let tesla = Self.period(source: .tesla, choice: .owner)
        let teslaTimeline = Self.timeline(country: Self.unitedStates, periods: [tesla])
        #expect(!RatePlanSourcePresentation.canRestoreTesla(tesla, in: teslaTimeline))
        let olderServer = Self.timeline(country: nil, periods: [override])
        #expect(!RatePlanSourcePresentation.canRestoreTesla(override, in: olderServer))
    }

    @Test("Public plans are offered only for a US site with a utility")
    func publicPlansOffered() {
        #expect(RatePlanSourcePresentation.offersPublicPlans(Self.timeline(country: Self.unitedStates)))
        #expect(!RatePlanSourcePresentation.offersPublicPlans(Self.timeline(country: Self.unitedStates, utility: nil)))
        let canada = SiteRateCountryDTO(countryCode: "CA", source: .owner, updatedAt: nil, eligibility: .outsideUS)
        #expect(!RatePlanSourcePresentation.offersPublicPlans(Self.timeline(country: canada)))
        #expect(TariffSheetModal.changePlan(for: Self.timeline(country: canada)) == .editor(.add))
    }

    @MainActor
    @Test("Review copy names the dates, recalculation and Powerwall effect")
    func reviewCopy() throws {
        #expect(RatePlanReviewPresentation.rangeLabel(from: "2025-03-01", to: nil).hasSuffix("ongoing"))
        let preview = try RatePlanReviewModelTests.preview()
        #expect(RatePlanReviewPresentation.recalculationNote(preview).contains("recalculated"))
        #expect(RatePlanReviewPresentation.powerwallWarning.contains("Your Powerwall will continue using"))
        let row = TariffAlignedTimeRow(
            fromHour: 16, fromMinute: 0, toHour: 21, toMinute: 0,
            before: TariffComparisonSlotRate(touName: .onPeak, buyRate: 0.3, sellRate: 0.05),
            after: TariffComparisonSlotRate(touName: .offPeak, buyRate: 0.12, sellRate: 0.05),
            buyRateDelta: -0.18, sellRateDelta: 0, buyRateChanged: true, sellRateChanged: false,
            rateChanged: true, periodNameChanged: true
        )
        #expect(RatePlanReviewPresentation.timeLabel(row) == "4:00 PM – 9:00 PM")
        let odd = TariffAlignedTimeRow(
            fromHour: 6, fromMinute: 7, toHour: 6, toMinute: 22, before: nil, after: nil,
            buyRateDelta: nil, sellRateDelta: nil, buyRateChanged: false, sellRateChanged: false,
            rateChanged: false, periodNameChanged: false
        )
        #expect(RatePlanReviewPresentation.timeLabel(odd) == "6:07 AM – 6:22 AM", "Minute boundaries are kept")
        let toMidnight = TariffAlignedTimeRow(
            fromHour: 21, fromMinute: 0, toHour: 24, toMinute: 0, before: nil, after: nil,
            buyRateDelta: nil, sellRateDelta: nil, buyRateChanged: false, sellRateChanged: false,
            rateChanged: false, periodNameChanged: false
        )
        #expect(RatePlanReviewPresentation.timeLabel(toMidnight) == "9:00 PM – 12:00 AM")
        let usage = RatePlanReviewPresentation.rateChange(
            before: row.before, after: row.after, rate: \.buyRate, currency: "USD"
        )
        #expect(usage.contains("Peak") && usage.contains("→"))
    }
}
