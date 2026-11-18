import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Choosing the site's country")
struct SiteCountryPickerModelTests {
    private static func timeline(
        eligibility: RatePlanEligibility,
        status: SiteRateEstimatesDTO.Status,
        utilityName: String? = nil
    ) -> SiteTariffsTimelineResponse {
        SiteTariffsTimelineResponse(
            version: 2, siteId: "site-a", timezone: "America/Chicago", currency: "USD", periods: [],
            reattribution: nil,
            teslaSync: TeslaSyncDTO(
                latestTariffId: nil, latestTariffName: nil, latestUpdatedAt: nil,
                activeManualUpdatedAt: nil, differsFromActiveManual: false
            ),
            estimates: SiteRateEstimatesDTO(
                status: status, utilityName: utilityName, teslaPlanOutOfDate: false, newerPlanName: nil,
                newerPlanStart: nil, newestRevisionStart: nil, mayBeOutdated: false
            ),
            rateCountry: SiteRateCountryDTO(countryCode: "US", source: .owner, updatedAt: nil, eligibility: eligibility)
        )
    }

    @Test("Border candidates are suggested first, and every ISO country is searchable")
    func suggestions() async {
        let model = SiteCountryPickerModel(
            inference: { .nearBorder(candidates: ["US", "CA"]) },
            save: { _ in throw CancellationError() },
            locale: Locale(identifier: "en_US")
        )
        await model.load()
        #expect(model.suggestions.map(\.code) == ["US", "CA"])
        #expect(model.suggestions.first?.name == "United States")
        #expect(model.countries.count > 200)
        model.query = "canad"
        #expect(model.countries.map(\.code) == ["CA"])
        model.query = "mx"
        #expect(model.countries.map(\.code) == ["MX"])
    }

    @Test("No saved location suggests nothing rather than guessing the US")
    func noSuggestions() async {
        let model = SiteCountryPickerModel(inference: { .noLocation }, save: { _ in throw CancellationError() })
        await model.load()
        #expect(model.suggestions.isEmpty)
    }

    @Test("Choosing the US continues to the utility; another country finishes")
    func outcomes() async {
        var saved: [String] = []
        let usModel = SiteCountryPickerModel(inference: { .noLocation }, save: { code in
            saved.append(code)
            return Self.timeline(eligibility: .unitedStates, status: .pending)
        })
        await usModel.select(SiteCountryOption(code: "US"))
        #expect(usModel.outcome == .publicPlansAvailable, "Utility discovery may still be pending")

        let chosenUtility = SiteCountryPickerModel(inference: { .noLocation }, save: { _ in
            Self.timeline(eligibility: .unitedStates, status: .ready, utilityName: "We Energies")
        })
        await chosenUtility.select(SiteCountryOption(code: "US"))
        #expect(chosenUtility.outcome == .done, "A site with a utility doesn't need the picker")

        let otherModel = SiteCountryPickerModel(inference: { .noLocation }, save: { code in
            saved.append(code)
            return Self.timeline(eligibility: .outsideUS, status: .skipped)
        })
        await otherModel.select(SiteCountryOption(code: "CA"))
        #expect(otherModel.outcome == .done)
        #expect(saved == ["US", "CA"])
    }

    @Test("A failed save shows the error and stays open")
    func failure() async {
        let model = SiteCountryPickerModel(inference: { .noLocation }, save: { _ in
            throw PWUsageAPIError.requestRejected(statusCode: 400, message: "Choose a valid two-letter country code.")
        })
        await model.select(SiteCountryOption(code: "US"))
        #expect(model.outcome == nil)
        #expect(model.errorMessage == "Choose a valid two-letter country code.")
        #expect(!model.isSaving)
    }
}
