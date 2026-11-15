import Foundation
@testable import PWUsage
import Testing

@Suite("Mobile Tariffs Decoding")
struct MobileTariffsDecodingTests {
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
}
