import Foundation
@testable import PWUsageCore
import Testing

@Suite("Tariff timeline validation")
struct TariffTimelineValidationTests {
    @Test("Rejects wrong site and non-v2 timeline version")
    func rejectsWrongSiteAndVersion() throws {
        let response = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffTimelineFixture.json.utf8)
        )
        #expect(throws: PWUsageAPIError.invalidResponse) { _ = try response.validating(siteID: "other") }
        #expect(throws: PWUsageAPIError.invalidResponse) {
            let version1 = TariffTimelineFixture.json.replacingOccurrences(of: "\"version\":2", with: "\"version\":1")
            _ = try MobileContractDecoder.make().decode(
                SiteTariffsTimelineResponse.self,
                from: Data(version1.utf8)
            )
            .validating(siteID: "a")
        }
    }

    @Test("Negative tariff rates are valid: the server prices negative buy and sell rates")
    func acceptsNegativeTariffRates() throws {
        let tariffFixture = TariffTimelineFixture.json.replacingOccurrences(of: #""buyRate":0.30335"#,
                                                                            with: #""buyRate":-0.3"#)
        let tariffs = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self, from: Data(tariffFixture.utf8)
        )
        #expect(try tariffs.validating(siteID: "a") == tariffs)
    }

    @Test("A tariff period with a non-finite rate is rejected")
    func rejectsNonFiniteTariffRate() throws {
        let fixture = TariffTimelineFixture.json.replacingOccurrences(
            of: #""sellRate":0.04906"#,
            with: #""sellRate":"nan""#
        )
        let decoder = MobileContractDecoder.make()
        decoder.nonConformingFloatDecodingStrategy = .convertFromString(positiveInfinity: "inf",
                                                                        negativeInfinity: "-inf", nan: "nan")
        let response = try decoder.decode(
            SiteTariffsTimelineResponse.self, from: Data(fixture.utf8)
        )
        #expect(throws: PWUsageAPIError.invalidResponse) { try response.validating(siteID: "a") }
    }
}
