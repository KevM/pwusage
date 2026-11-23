import Foundation
@testable import PWUsageCore
import Testing

@Suite("Rate plan selection decoding")
struct RatePlanSelectionDecodingTests {
    private static func timelineJSON(
        extraTimeline: String = "",
        extraPeriod: String = "",
        extraEstimates: String = ""
    ) -> String {
        """
        {
          "version": 2, "siteId": "site-1", "timezone": "America/Chicago", "currency": "USD",
          "periods": [{
            "periodId": 7, "tariffId": 17, "name": "Residential", "version": 1, "source": "estimated",
            "effectiveFrom": "2025-01-01", "effectiveTo": null, "isCurrentToday": true, "updatedBy": null,
            "seasons": []\(extraPeriod)
          }],
          "battery": null, "reattribution": null,
          "teslaSync": { "latestTariffId": null, "latestTariffName": null, "latestUpdatedAt": null,
                         "differsFromActiveManual": false,
                         "syncAvailable": false, "syncUnavailableReason": null, "lastSync": null },
          "estimates": { "status": "ready", "utilityName": "We Energies", "teslaPlanOutOfDate": false,
                         "newerPlanName": null, "newerPlanStart": null, "newestRevisionStart": null,
                         "mayBeOutdated": false\(extraEstimates) }\(extraTimeline)
        }
        """
    }

    private static func decodeTimeline(_ json: String) throws -> SiteTariffsTimelineResponse {
        try MobileContractDecoder.make().decode(SiteTariffsTimelineResponse.self, from: Data(json.utf8))
    }

    @Test("Older servers without selection or country fields still decode")
    func decodesWithoutSelectionFields() throws {
        let timeline = try Self.decodeTimeline(Self.timelineJSON())
        #expect(timeline.rateCountry == nil)
        #expect(timeline.estimates?.eligibility == nil)
        #expect(timeline.estimates?.needsCountryConfirmation == nil)
        let period = try #require(timeline.periods.first)
        #expect(period.selectionId == nil)
        #expect(period.choiceKind == nil)
        #expect(period.verification == nil)
    }

    @Test("Decodes selection provenance, verification and the site's country")
    func decodesSelectionFields() throws {
        let timeline = try Self.decodeTimeline(Self.timelineJSON(
            extraTimeline: """
            , "rateCountry": { "countryCode": "US", "source": "solar_location",
                               "updatedAt": "2026-11-17T12:00:00Z", "eligibility": "us" }
            """,
            extraPeriod: """
            , "selectionId": 41, "choiceKind": "owner", "urdbLabel": "abc123",
              "verification": { "verifiedAt": "2026-11-17T12:00:00Z", "verifiedByEmail": null,
                                "verifiedByCurrentUser": true }
            """,
            extraEstimates: """
            , "eligibility": "outside_us", "needsCountryConfirmation": false, "hasIneligiblePublicSelection": true
            """
        ))
        #expect(timeline.rateCountry == SiteRateCountryDTO(
            countryCode: "US", source: .solarLocation, updatedAt: "2026-11-17T12:00:00Z", eligibility: .unitedStates
        ))
        #expect(timeline.estimates?.eligibility == .outsideUS)
        #expect(timeline.estimates?.hasIneligiblePublicSelection == true)
        let period = try #require(timeline.periods.first)
        #expect(period.selectionId == 41)
        #expect(period.choiceKind == .owner)
        #expect(period.urdbLabel == "abc123")
        #expect(period.verification?.verifiedByCurrentUser == true)
    }

    @Test("Review validation rejects a different site")
    func rejectsReviewForDifferentSite() throws {
        let preview = try MobileContractDecoder.make()
            .decode(TariffSelectionPreviewResponse.self, from: Data(RatePlanResponseFixture.previewJSON.utf8))
        #expect(try preview.validating(siteID: "site-1") == preview)
        #expect(throws: PWUsageAPIError.invalidResponse) { try preview.validating(siteID: "site-2") }
    }

    @Test("Selection conflicts become typed errors; other conflicts do not")
    func decodesConflicts() throws {
        let preview = RatePlanResponseFixture.previewJSON
        let stale = "{\"error\":\"x\",\"code\":\"REVIEW_STALE\",\"refreshPath\":\"/p\",\"preview\":\(preview)}"
        guard case .reviewStale(let fresh) = RatePlanSelectionConflict.decode(from: Data(stale.utf8)) else {
            Issue.record("Expected a stale review")
            return
        }
        #expect(fresh.reviewHash == "hash-1")
        let ineligible = #"{"error":"x","code":"PUBLIC_PLANS_UNAVAILABLE","eligibility":"outside_us"}"#
        #expect(RatePlanSelectionConflict.decode(from: Data(ineligible.utf8)) == .publicPlansUnavailable(.outsideUS))
        #expect(RatePlanSelectionConflict.decode(from: Data(#"{"error":"Utility changed"}"#.utf8)) == nil)
    }

    @Test("AI handoff review conflicts carry the fresh batch")
    func decodesAiHandoffConflict() {
        let batchPreviewJSON = RatePlanResponseFixture.batchPreviewJSON
        let conflictJSON = "{\"error\":\"Stale\",\"code\":\"REVIEW_STALE\",\"preview\":\(batchPreviewJSON)}"
        let decodedConflict = RatePlanSelectionConflict.decode(from: Data(conflictJSON.utf8))
        guard case .aiHandoffReviewStale(let freshBatch) = decodedConflict else {
            Issue.record("Expected aiHandoffReviewStale")
            return
        }
        #expect(freshBatch.reviewHash == "batch-hash-1")
    }
}
