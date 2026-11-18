import Foundation
@testable import PWUsage
import Testing

extension MobileTariffsDecodingTests {
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
                         "differsFromActiveManual": false },
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

    @Test("Selection requests always send explicit dates, with null meaning ongoing")
    func encodesSelectionRequests() throws {
        let request = TariffSelectionRequest(
            scope: .actual, candidate: .publicPlan(label: "abc123"), effectiveFrom: "2025-03-01", effectiveTo: nil
        )
        let commit = TariffSelectionCommit(request: request, expectedReviewHash: "hash-1", verifiedAgainstBill: false)
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(commit)) as? [String: Any])
        #expect(Set(object.keys) == [
            "scope", "candidate", "effectiveFrom", "effectiveTo", "expectedReviewHash", "verifiedAgainstBill"
        ])
        #expect(object["effectiveTo"] is NSNull)
        #expect(object["verifiedAgainstBill"] as? Bool == false)
        #expect(object["candidate"] as? [String: String] == ["kind": "public", "label": "abc123"])

        let restore = try JSONEncoder().encode(TariffSelectionCandidate.restoreTesla(originalSelectionID: 9))
        let restoreObject = try JSONSerialization.jsonObject(with: restore) as? [String: AnyHashable]
        #expect(restoreObject == ["kind": "restore_tesla", "originalSelectionId": 9])
    }

    @Test("Decodes a review with restoration provenance and tolerates new note kinds")
    func decodesPreview() throws {
        let preview = try MobileContractDecoder.make()
            .decode(TariffSelectionPreviewResponse.self, from: Data(Self.previewJSON.utf8))
            .validating(siteID: "site-1")
        #expect(preview.reviewHash == "hash-1")
        #expect(preview.approximationNotes.map(\.kind) == [.tierBlended, .other])
        let interval = try #require(preview.affectedIntervals.first)
        #expect(interval.kind == .replace)
        #expect(interval.before?.source == .tesla)
        #expect(interval.after?.exportRateProvenance == .netMetering)
        guard case .preservesTeslaOriginal(let original) = interval.restoration else {
            Issue.record("Expected the Tesla original to be preserved")
            return
        }
        #expect(original.tariffId == 17)
        #expect(throws: PWUsageAPIError.invalidResponse) { try preview.validating(siteID: "site-2") }
    }

    @Test("Selection conflicts become typed errors; other conflicts do not")
    func decodesConflicts() throws {
        let stale = "{\"error\":\"x\",\"code\":\"REVIEW_STALE\",\"refreshPath\":\"/p\",\"preview\":\(Self.previewJSON)}"
        guard case .reviewStale(let fresh) = RatePlanSelectionConflict.decode(from: Data(stale.utf8)) else {
            Issue.record("Expected a stale review")
            return
        }
        #expect(fresh.reviewHash == "hash-1")
        let ineligible = #"{"error":"x","code":"PUBLIC_PLANS_UNAVAILABLE","eligibility":"outside_us"}"#
        #expect(RatePlanSelectionConflict.decode(from: Data(ineligible.utf8)) == .publicPlansUnavailable(.outsideUS))
        #expect(RatePlanSelectionConflict.decode(from: Data(#"{"error":"Utility changed"}"#.utf8)) == nil)
    }

    @Test("Public plans decode with and without rate details")
    func decodesPublicPlans() throws {
        let old = try JSONDecoder().decode(
            UtilityPlanDTO.self, from: Data(#"{"label":"a","name":"Residential","startDate":"2025-01-01"}"#.utf8)
        )
        #expect(old.seasons == nil)
        let json = """
        {"utilityName":"We Energies","effectiveDate":"2025-03-01","currency":"USD","unit":"kWh","plans":[
          {"label":"a","name":"Residential","utilityName":"We Energies","startDate":"2025-01-01",
           "revisionStart":"2025-01-01","kind":"time_of_use","isDefault":true,"currency":"USD","unit":"kWh",
           "holidaysUseWeekendSchedule":true,"exportRateProvenance":"published","seasons":[],
           "approximationNotes":[]}]}
        """
        let response = try JSONDecoder().decode(PublicUtilityPlansResponse.self, from: Data(json.utf8))
        let plan = try #require(response.plans.first)
        #expect(plan.kind == .timeOfUse)
        #expect(plan.exportRateProvenance == .published)
        #expect(plan.seasons == [])
    }

    private static let snapshotFields = """
    "utilityName": null, "choiceKind": "automatic", "urdbLabel": null, "revisionStart": null,
    "contentHash": "c", "holidaysUseWeekendSchedule": true, "seasons": [], "approximationNotes": [],
    "verification": null
    """

    static let previewJSON = """
    {
      "reviewHash": "hash-1", "siteId": "site-1", "scope": "actual",
      "effectiveFrom": "2025-03-01", "effectiveTo": null, "currency": "USD", "unit": "kWh",
      "timezone": "America/Chicago", "holidaysUseWeekendSchedule": true, "recalculatesHistory": true,
      "recalculatesFromHistoryStart": false,
      "recalculationRange": { "fromDate": "2025-03-01", "toDate": null }, "affectsPowerwallPlan": false,
      "candidatePlan": null,
      "affectedIntervals": [{
        "effectiveFrom": "2025-03-01", "effectiveTo": null, "kind": "replace", "beforeIsFallback": false,
        "before": { "tariffId": 17, "version": 1, "periodId": 7, "selectionId": null, "name": "Tesla",
                    "source": "tesla", "exportRateProvenance": "tesla", \(snapshotFields) },
        "after": { "tariffId": null, "version": null, "periodId": null, "selectionId": null, "name": "Public",
                   "source": "estimated", "exportRateProvenance": "net_metering", \(snapshotFields) },
        "seasons": [], "hasBuyRateChanges": true, "hasSellRateChanges": false, "hasRateChanges": true,
        "hasPeriodNameChanges": false,
        "restoration": { "status": "preserves_tesla_original", "original": {
          "originalSelectionId": 3, "tariffId": 17, "name": "Tesla", "version": 1, "contentHash": "c",
          "effectiveFrom": "2025-01-01", "effectiveTo": null } }
      }],
      "unchangedOutsidePeriods": [],
      "restoration": { "preservedOriginals": [], "restoredOriginals": [], "unavailableRanges": [],
                       "canApplyRestoration": true },
      "approximationNotes": [{ "kind": "tier_blended", "message": "Tiers blended" },
                             { "kind": "something_new", "message": "New" }],
      "summary": { "hasBuyRateChanges": true, "hasSellRateChanges": false, "hasRateChanges": true,
                   "hasPeriodNameChanges": false, "fillsGap": false, "replacesExistingPlan": true }
    }
    """
}
