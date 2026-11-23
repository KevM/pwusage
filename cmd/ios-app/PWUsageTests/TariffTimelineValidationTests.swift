import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

/// The tariff timeline check lives in the app because it throws the app's `PWUsageAPIError`.
@Suite("Tariff timeline validation")
struct TariffTimelineValidationTests {
    @Test("Negative tariff rates are valid: the server prices negative buy and sell rates")
    func acceptsNegativeTariffRates() throws {
        let tariffFixture = TariffSheetTests.fixture.replacingOccurrences(of: #""buyRate":0.30335"#,
                                                                          with: #""buyRate":-0.3"#)
        let tariffs = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self, from: Data(tariffFixture.utf8)
        )
        #expect(try tariffs.validating(siteID: "a") == tariffs)
    }

    @Test("A tariff period with a non-finite rate is rejected")
    func rejectsNonFiniteTariffRate() throws {
        let fixture = TariffSheetTests.fixture.replacingOccurrences(
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
