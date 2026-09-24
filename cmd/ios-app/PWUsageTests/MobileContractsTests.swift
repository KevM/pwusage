import Foundation
import Testing
@testable import PWUsage

@Suite("Mobile Contracts Tests")
struct MobileContractsTests {
    @Test("Decodes sites fixture")
    func decodesSitesFixture() throws {
        let fixture = try #require(#"[{"id":"site-1","name":"Home","utility":"Utility Co"}]"#.data(using: .utf8))
        let sites = try JSONDecoder().decode([MobileSite].self, from: fixture)
        #expect(sites == [MobileSite(id: "site-1", name: "Home", utility: "Utility Co")])
    }

    @Test("Decodes mobile live fixture and nullable fields")
    func decodesMobileLiveFixtureAndNullableFields() throws {
        let fixture = try #require(#"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"America/Chicago","localDate":"2026-09-23"},"live":{"solarPower":1200,"loadPower":900,"batteryPower":-300,"gridPower":0},"stateOfCharge":null,"activeTariff":null,"today":{"homeKwh":12,"solarKwh":8,"gridNetKwh":4,"batteryNetKwh":1},"todayComplete":true,"currentBill":null,"sources":{"liveStatusAt":"2026-09-23T12:34:56.123Z","energyDataThrough":null}}"#.data(using: .utf8))
        let response = try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: fixture)
        #expect(response.stateOfCharge == nil)
        #expect(response.activeTariff == nil)
        #expect(response.currentBill == nil)
        #expect(response.sources.energyDataThrough == nil)
        #expect(response.sources.liveStatusAt == ISO8601DateFormatter.parse("2026-09-23T12:34:56.123Z"))
        #expect(response.live.batteryPower == -300)
    }

    @Test("Rejects unsupported live version")
    func rejectsUnsupportedLiveVersion() throws {
        let fixture = try #require(#"{"version":2}"#.data(using: .utf8))
        #expect(throws: MobileLiveResponse.ContractError.unsupportedVersion(2)) {
            try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: fixture)
        }
    }

    @Test("Decodes bill fixture including periods and fractional dates")
    func decodesBillFixtureIncludingPeriodsAndFractionalDates() throws {
        let fixture = try #require(#"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"America/Chicago"},"currentBill":{"estimatedCost":null,"currency":"USD","cycleStart":"2026-09-01T00:00:00.000Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[{"tariffName":"Residential","periodName":"Off peak","netGridKwh":-1.25,"cost":-0.12}]},"sources":{"calculatedAt":"2026-09-23T12:34:56.123Z","energyDataThrough":null}}"#.data(using: .utf8))
        let response = try MobileContractDecoder.make().decode(MobileBillResponse.self, from: fixture)
        #expect(response.currentBill.estimatedCost == nil)
        #expect(response.sources.energyDataThrough == nil)
        #expect(response.currentBill.periods == [Period(tariffName: "Residential", periodName: "Off peak", netGridKwh: -1.25, cost: -0.12)])
        #expect(response.sources.calculatedAt == ISO8601DateFormatter.parse("2026-09-23T12:34:56.123Z"))
        #expect(try response.validating(siteID: "site-1") == response)
    }

    @Test("Rejects unsupported bill version and other site")
    func rejectsUnsupportedBillVersionAndOtherSite() throws {
        let unsupported = try #require(#"{"version":3}"#.data(using: .utf8))
        #expect(throws: MobileBillResponse.ContractError.unsupportedVersion(3)) {
            try MobileContractDecoder.make().decode(MobileBillResponse.self, from: unsupported)
        }
        let fixture = try #require(#"{"version":1,"site":{"id":"other","name":"Away","timezone":"UTC"},"currentBill":{"estimatedCost":0,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"sources":{"calculatedAt":"2026-09-23T12:34:56Z","energyDataThrough":null}}"#.data(using: .utf8))
        let response = try MobileContractDecoder.make().decode(MobileBillResponse.self, from: fixture)
        #expect(throws: MobileBillResponse.ContractError.siteMismatch(expected: "site-1", actual: "other")) {
            try response.validating(siteID: "site-1")
        }
    }
}

private extension ISO8601DateFormatter {
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = value.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
