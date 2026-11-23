import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@Suite("Mobile Tariffs Decoding")
struct MobileTariffsDecodingTests {
    private static let estimatedTimelineJSON = """
    {
      "version": 2,
      "siteId": "site-1",
      "timezone": "America/Chicago",
      "currency": "USD",
      "periods": [{
        "periodId": 7,
        "tariffId": 17,
        "name": "Residential",
        "version": 1,
        "source": "estimated",
        "effectiveFrom": "2025-01-01",
        "effectiveTo": null,
        "isCurrentToday": true,
        "updatedBy": null,
        "startSource": "urdb",
        "seasons": []
      }],
      "referencePeriods": [{
        "periodId": 8,
        "tariffId": 18,
        "name": "Fixed Reference",
        "version": 1,
        "source": "estimated",
        "effectiveFrom": "2025-01-01",
        "effectiveTo": null,
        "isCurrentToday": true,
        "updatedBy": null,
        "seasons": []
      }],
      "battery": null,
      "reattribution": null,
      "holidayDates": [],
      "teslaSync": {
        "latestTariffId": null,
        "latestTariffName": null,
        "latestUpdatedAt": null,
        "differsFromActiveManual": false, "syncAvailable": false, "syncUnavailableReason": null, "lastSync": null
      },
      "estimates": {
        "status": "ready",
        "utilityName": "We Energies",
        "teslaPlanOutOfDate": true,
        "newerPlanName": "Residential Option A",
        "newerPlanStart": "2025-06-01",
        "newestRevisionStart": "2025-06-01",
        "mayBeOutdated": true
      }
    }
    """

    @Test("Decodes referencePeriods and battery when present")
    func decodesReferencePeriodsAndBattery() throws {
        let json = """
        {
          "version": 2,
          "siteId": "site-1",
          "timezone": "America/Chicago",
          "currency": "USD",
          "periods": [],
          "referencePeriods": [
            {
              "periodId": 9,
              "tariffId": 19,
              "name": "Standard Fixed",
              "version": 1,
              "source": "manual",
              "effectiveFrom": "2024-01-01",
              "effectiveTo": null,
              "isCurrentToday": true,
              "updatedBy": null,
              "seasons": []
            }
          ],
          "battery": {
            "nameplateEnergyWh": 13500,
            "nameplatePowerW": 5000,
            "backupReservePercent": 20
          },
          "reattribution": null,
          "holidayDates": ["2026-01-01"],
          "teslaSync": {
            "latestTariffId": null,
            "latestTariffName": null,
            "latestUpdatedAt": null,
            "differsFromActiveManual": false, "syncAvailable": false, "syncUnavailableReason": null, "lastSync": null
          }
        }
        """

        let decoded = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(json.utf8)
        )
        #expect(decoded.referencePeriods.count == 1)
        #expect(decoded.referencePeriods.first?.name == "Standard Fixed")
        #expect(decoded.battery == SiteBatteryDTO(
            nameplateEnergyWh: 13500,
            nameplatePowerW: 5000,
            backupReservePercent: 20
        ))
    }

    @Test("Decodes existing timeline fixture without referencePeriods or battery")
    func decodesTimelineWithoutReferenceFields() throws {
        let decoded = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffSheetTests.fixture.utf8)
        )
        #expect(decoded.referencePeriods.isEmpty)
        #expect(decoded.battery == nil)
    }

    @Test("Decodes estimated sources, start sources, reference source, and estimate status")
    func decodesEstimatedSourceAndStartSource() throws {
        let decoded = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(Self.estimatedTimelineJSON.utf8)
        )

        #expect(decoded.periods.first?.source == .estimated)
        #expect(decoded.periods.first?.startSource == .urdb)
        #expect(decoded.referencePeriods.first?.source == .estimated)
        #expect(decoded.estimates?.status == .ready)
        #expect(decoded.estimates?.utilityName == "We Energies")
        #expect(decoded.estimates?.teslaPlanOutOfDate == true)
        #expect(decoded.estimates?.newerPlanName == "Residential Option A")
        #expect(decoded.estimates?.newerPlanStart == "2025-06-01")
        #expect(decoded.estimates?.newestRevisionStart == "2025-06-01")
        #expect(decoded.estimates?.mayBeOutdated == true)
    }

    @Test("Decodes estimate freshness as null dates and not outdated when no estimate covers today")
    func decodesEstimateFreshnessWithoutRevision() throws {
        let json = Self.estimatedTimelineJSON.replacingOccurrences(
            of: "\"newestRevisionStart\": \"2025-06-01\"",
            with: "\"newestRevisionStart\": null"
        ).replacingOccurrences(of: "\"mayBeOutdated\": true", with: "\"mayBeOutdated\": false")
            .replacingOccurrences(of: "\"newerPlanStart\": \"2025-06-01\"", with: "\"newerPlanStart\": null")
        let decoded = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(json.utf8)
        )

        #expect(decoded.estimates?.newestRevisionStart == nil)
        #expect(decoded.estimates?.mayBeOutdated == false)
        #expect(decoded.estimates?.newerPlanStart == nil)
    }

    @Test("Decodes a timeline without the estimates block")
    func decodesTimelineWithoutEstimates() throws {
        let decoded = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffSheetTests.fixture.utf8)
        )

        #expect(decoded.estimates == nil)
    }

    @Test("Decodes the history guide offer")
    func decodesHistoryGuide() throws {
        let json = Self.estimatedTimelineJSON.replacingOccurrences(
            of: "\"mayBeOutdated\": true",
            with: "\"mayBeOutdated\": true, \"historyGuide\": {\"historyStart\": \"2023-11-14\", "
                + "\"fillThrough\": \"2025-01-01\", \"unconfirmedDays\": 412}"
        )
        let decoded = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(json.utf8)
        )

        #expect(decoded.estimates?.historyGuide == RatePlanHistoryGuideDTO(
            historyStart: "2023-11-14", fillThrough: "2025-01-01", unconfirmedDays: 412
        ))
    }

    @Test("Decodes a null history guide and a missing one as nil")
    func decodesTimelineWithoutHistoryGuide() throws {
        let decoder = MobileContractDecoder.make()
        let missing = try decoder.decode(
            SiteTariffsTimelineResponse.self, from: Data(Self.estimatedTimelineJSON.utf8)
        )
        #expect(missing.estimates?.historyGuide == nil)

        let json = Self.estimatedTimelineJSON.replacingOccurrences(
            of: "\"mayBeOutdated\": true", with: "\"mayBeOutdated\": true, \"historyGuide\": null"
        )
        let explicit = try decoder.decode(SiteTariffsTimelineResponse.self, from: Data(json.utf8))
        #expect(explicit.estimates?.historyGuide == nil)
    }

    @Test("Decodes systemCosts with solar and Powerwall components")
    func decodesSystemCosts() throws {
        let json = Self.estimatedTimelineJSON.replacingOccurrences(
            of: "\"reattribution\": null,",
            with: """
            "reattribution": null,
              "systemCosts": {
                "siteInstalled": "2024-02-14",
                "solar": {
                  "installDate": "2024-03-04",
                  "price": 16100,
                  "taxCreditPercent": 30,
                  "incentives": 1200
                },
                "powerwall": {
                  "installDate": null,
                  "price": 9000,
                  "taxCreditPercent": null,
                  "incentives": 0
                }
              },
            """
        )
        let decoded = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(json.utf8)
        )

        #expect(decoded.systemCosts == SystemCostsDTO(
            siteInstalled: "2024-02-14",
            solar: SystemCostDTO(installDate: "2024-03-04", price: 16_100, taxCreditPercent: 30, incentives: 1_200),
            powerwall: SystemCostDTO(installDate: nil, price: 9_000, taxCreditPercent: nil, incentives: 0)
        ))
    }

    @Test("Decodes a timeline without systemCosts as nil")
    func decodesTimelineWithoutSystemCosts() throws {
        let decoded = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffSheetTests.fixture.utf8)
        )

        #expect(decoded.systemCosts == nil)
    }

    @Test("Decodes Sync to Tesla availability, unavailable reason and last attempt")
    func decodesTeslaSyncFields() throws {
        let json = """
        {
          "version": 2,
          "siteId": "site-1",
          "timezone": "America/Chicago",
          "currency": "USD",
          "periods": [],
          "referencePeriods": [],
          "battery": null,
          "reattribution": null,
          "holidayDates": [],
          "teslaSync": {
            "latestTariffId": 9,
            "latestTariffName": "Tesla Plan",
            "latestUpdatedAt": "2026-09-01T00:00:00.000Z",
            "activeManualUpdatedAt": null,
            "differsFromActiveManual": false,
            "syncAvailable": false,
            "syncUnavailableReason": "no_difference",
            "lastSync": { "status": "unconfirmed", "at": "2026-11-18T10:00:00.000Z" }
          }
        }
        """

        let decoded = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(json.utf8)
        )
        #expect(decoded.teslaSync.syncAvailable == false)
        #expect(decoded.teslaSync.syncUnavailableReason == "no_difference")
        #expect(decoded.teslaSync.lastSync == TeslaSyncAttemptDTO(
            status: "unconfirmed",
            timestamp: "2026-11-18T10:00:00.000Z"
        ))

        let lastSyncLine = "\"lastSync\": { \"status\": \"unconfirmed\", \"at\": \"2026-11-18T10:00:00.000Z\" }"
        let none = json.replacingOccurrences(of: lastSyncLine, with: "\"lastSync\": null")
        let noneDecoded = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(none.utf8)
        )
        #expect(noneDecoded.teslaSync.lastSync == nil)
    }
}
