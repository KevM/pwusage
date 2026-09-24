import XCTest
@testable import PWUsage

final class MobileContractsTests: XCTestCase {
    func testDecodesSitesFixture() throws {
        let fixture = #"[{"id":"site-1","name":"Home","utility":"Utility Co"}]"#.data(using: .utf8)!
        let sites = try JSONDecoder().decode([MobileSite].self, from: fixture)
        XCTAssertEqual(sites, [MobileSite(id: "site-1", name: "Home", utility: "Utility Co")])
    }

    func testDecodesMobileLiveFixtureAndNullableFields() throws {
        let fixture = #"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"America/Chicago","localDate":"2026-09-23"},"live":{"solarPower":1200,"loadPower":900,"batteryPower":-300,"gridPower":0},"stateOfCharge":null,"activeTariff":null,"today":{"homeKwh":12,"solarKwh":8,"gridNetKwh":4,"batteryNetKwh":1},"todayComplete":true,"currentBill":null,"sources":{"liveStatusAt":"2026-09-23T12:34:56.123Z","energyDataThrough":null}}"#.data(using: .utf8)!
        let response = try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: fixture)
        XCTAssertNil(response.stateOfCharge)
        XCTAssertNil(response.activeTariff)
        XCTAssertNil(response.currentBill)
        XCTAssertNil(response.sources.energyDataThrough)
        XCTAssertEqual(response.sources.liveStatusAt, ISO8601DateFormatter.parse("2026-09-23T12:34:56.123Z"))
        XCTAssertEqual(response.live.batteryPower, -300)
    }

    func testRejectsUnsupportedLiveVersion() throws {
        let fixture = #"{"version":2}"#.data(using: .utf8)!
        XCTAssertThrowsError(try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: fixture)) { error in
            XCTAssertEqual(error as? MobileLiveResponse.ContractError, .unsupportedVersion(2))
        }
    }

    func testDecodesBillFixtureIncludingPeriodsAndFractionalDates() throws {
        let fixture = #"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"America/Chicago"},"currentBill":{"estimatedCost":null,"currency":"USD","cycleStart":"2026-09-01T00:00:00.000Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[{"tariffName":"Residential","periodName":"Off peak","netGridKwh":-1.25,"cost":-0.12}]},"sources":{"calculatedAt":"2026-09-23T12:34:56.123Z","energyDataThrough":null}}"#.data(using: .utf8)!
        let response = try MobileContractDecoder.make().decode(MobileBillResponse.self, from: fixture)
        XCTAssertNil(response.currentBill.estimatedCost)
        XCTAssertNil(response.sources.energyDataThrough)
        XCTAssertEqual(response.currentBill.periods, [Period(tariffName: "Residential", periodName: "Off peak", netGridKwh: -1.25, cost: -0.12)])
        XCTAssertEqual(response.sources.calculatedAt, ISO8601DateFormatter.parse("2026-09-23T12:34:56.123Z"))
        XCTAssertEqual(try response.validating(siteID: "site-1"), response)
    }

    func testRejectsUnsupportedBillVersionAndOtherSite() throws {
        let unsupported = #"{"version":3}"#.data(using: .utf8)!
        XCTAssertThrowsError(try MobileContractDecoder.make().decode(MobileBillResponse.self, from: unsupported)) { error in
            XCTAssertEqual(error as? MobileBillResponse.ContractError, .unsupportedVersion(3))
        }
        let fixture = #"{"version":1,"site":{"id":"other","name":"Away","timezone":"UTC"},"currentBill":{"estimatedCost":0,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"sources":{"calculatedAt":"2026-09-23T12:34:56Z","energyDataThrough":null}}"#.data(using: .utf8)!
        let response = try MobileContractDecoder.make().decode(MobileBillResponse.self, from: fixture)
        XCTAssertThrowsError(try response.validating(siteID: "site-1")) { error in
            XCTAssertEqual(error as? MobileBillResponse.ContractError, .siteMismatch(expected: "site-1", actual: "other"))
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
