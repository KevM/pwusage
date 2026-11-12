import Foundation
@testable import PWUsage
import Testing

extension MobileContractsTests {
    @Test("A bill with a non-finite cost or rate is rejected", arguments: nonFiniteBillFixtures)
    func rejectsNonFiniteBillAmounts(fixture: String) throws {
        let response = try Self.nonConformingDecoder().decode(MobileBillResponse.self, from: Data(fixture.utf8))
        #expect(throws: MobileBillResponse.ContractError.invalidAmount) { try response.validating(siteID: "site-1") }
    }

    @Test("Negative rates and costs are valid: the server prices negative buy and sell rates")
    func acceptsNegativeRatesAndCosts() throws {
        let bill = Self.billBase
            + #""estimatedCost":-4.5,"periods":[{"tariffName":"R","periodName":"Export","netGridKwh":-3,"#
            + #""cost":-0.3}]},"loadTiming":{"hasTariff":true,"hasCycleData":true,"activeIsCheapest":true,"#
            + #""periods":[{"name":"Export","marginalCost":-0.1,"basis":"sell","cycleNetExportKwh":3,"#
            + #""isActive":true,"nextStartPhrase":null,"buyRate":-0.1,"sellRate":-0.04}],"pricingPeriods":[]}}"#
        let response = try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(bill.utf8))
        #expect(try response.validating(siteID: "site-1") == response)
        let tariffFixture = TariffSheetTests.fixture.replacingOccurrences(of: #""buyRate":0.30335"#,
                                                                          with: #""buyRate":-0.3"#)
        let tariffs = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self, from: Data(tariffFixture.utf8)
        )
        #expect(try tariffs.validating(siteID: "a") == tariffs)
    }

    @Test("Bill decodes optional tariffReattribution status")
    func decodesOptionalBillReattributionStatus() throws {
        let bill = Self.billBase
            + #""estimatedCost":10,"periods":[]},"loadTiming":null,"#
            + #""tariffReattribution":{"status":"running","fromDate":"2026-01-01","toDate":null,"#
            + #""totalDays":50,"processedDays":20,"updatedDays":12,"lastError":null,"#
            + #""updatedAt":"2026-09-23T10:00:00Z"}}"#
        let response = try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(bill.utf8))
        #expect(response.tariffReattribution?.status == .running)
        #expect(response.tariffReattribution?.processedDays == 20)
    }

    @Test("A live response with a non-finite bill amount or rate is rejected", arguments: nonFiniteLiveFixtures)
    func rejectsNonFiniteLiveAmounts(field: String) throws {
        let fixture = #"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"UTC","#
            + #""localDate":"2026-09-23"},"live":{"solarPower":0,"loadPower":0,"batteryPower":0,"#
            + #""gridPower":0},"today":{"homeKwh":1,"solarKwh":1,"gridNetKwh":0,"batteryNetKwh":0},"#
            + #""todayComplete":false,"sources":{"energyDataThrough":null},"# + field + "}"
        let response = try Self.nonConformingDecoder().decode(MobileLiveResponse.self, from: Data(fixture.utf8))
        #expect(throws: MobileLiveResponse.ContractError.invalidAmount) { try response.validating(siteID: "site-1") }
    }

    @Test("A tariff period with a non-finite rate is rejected")
    func rejectsNonFiniteTariffRate() throws {
        let fixture = TariffSheetTests.fixture.replacingOccurrences(
            of: #""sellRate":0.04906"#,
            with: #""sellRate":"nan""#
        )
        let response = try Self.nonConformingDecoder().decode(
            SiteTariffsTimelineResponse.self, from: Data(fixture.utf8)
        )
        #expect(throws: PWUsageAPIError.invalidResponse) { try response.validating(siteID: "a") }
    }
}
