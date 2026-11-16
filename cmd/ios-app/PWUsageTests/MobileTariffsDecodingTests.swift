import Foundation
@testable import PWUsage
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
        "differsFromActiveManual": false
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
            "differsFromActiveManual": false
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

    @Test("Decodes the rate plan history response")
    func decodesRateHistoryResponse() throws {
        let plan = """
        {"name": "Residential TOU", "startDate": "2024-03-01", "kind": "time_of_use", "isDefault": false,
         "closest": true, "lowRate": 0.11, "highRate": 0.32,
         "peakWindows": [{"label": "4-9 PM", "fromHour": 16, "toHour": 21},
                         {"label": "5-8 PM", "fromHour": 17, "toHour": 20}],
         "closestWindow": "4-9 PM", "fixedLabel": null}
        """
        let fixed = """
        {"name": "Residential Flat", "startDate": "2024-01-01", "kind": "fixed", "isDefault": true,
         "closest": false, "lowRate": 0.2, "highRate": 0.2, "peakWindows": [],
         "closestWindow": null, "fixedLabel": "abc123"}
        """
        let json = """
        {"utilityName": "Demo Electric", "historyStart": "2023-11-14", "fillThrough": null,
         "teslaShape": "time_of_use", "current": [\(plan)],
         "years": [{"year": 2024, "askDate": "2024-06-01", "plans": [\(plan), \(fixed)]}]}
        """
        let decoded = try MobileContractDecoder.make().decode(RatePlanHistoryDTO.self, from: Data(json.utf8))

        #expect(decoded.utilityName == "Demo Electric")
        #expect(decoded.fillThrough == nil)
        #expect(decoded.teslaShape == .timeOfUse)
        #expect(decoded.current.first?.peakWindows.map(\.label) == ["4-9 PM", "5-8 PM"])
        #expect(decoded.current.first?.closestWindow == "4-9 PM")
        #expect(decoded.years.first?.year == 2024)
        #expect(decoded.years.first?.plans.last?.kind == .fixed)
        #expect(decoded.years.first?.plans.last?.fixedLabel == "abc123")
        #expect(decoded.years.first?.plans.last?.id == "Residential Flat")
    }

    @Test("Encodes an open period with a null to")
    func encodesOpenPeriodWithNullTo() throws {
        let data = try JSONEncoder().encode([
            RatePlanHistoryPeriod(label: "abc", from: "2024-01-01", to: nil),
            RatePlanHistoryPeriod(label: "def", from: "2023-01-01", to: "2023-12-31")
        ])
        let json = try #require(String(data: data, encoding: .utf8))

        #expect(json.contains("\"to\":null"))
        #expect(json.contains("\"to\":\"2023-12-31\""))
    }
}
