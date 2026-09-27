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

    @Test("Decodes optional active load timing and keeps missing or null fields compatible")
    func decodesOptionalActiveLoadTiming() throws {
        let base = #"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"America/Chicago","localDate":"2026-09-23"},"live":{"solarPower":1,"loadPower":2,"batteryPower":3,"gridPower":4},"stateOfCharge":null,"activeTariff":"Peak","today":{"homeKwh":1,"solarKwh":1,"gridNetKwh":0,"batteryNetKwh":0},"todayComplete":false,"currentBill":null,"sources":{"liveStatusAt":null,"energyDataThrough":null,"stateOfChargeAt":null}"#
        let oldResponse = try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data((base + "}").utf8))
        #expect(oldResponse.activeLoadTiming == nil)

        let nullResponse = try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data((base.replacingOccurrences(of: "\"currentBill\":null", with: "\"activeLoadTiming\":null,\"currentBill\":null") + "}").utf8))
        #expect(nullResponse.activeLoadTiming == nil)

        let populated = base.replacingOccurrences(of: "\"currentBill\":null", with: #""activeLoadTiming":{"periodName":"Peak","buyRate":0.48,"sellRate":0.12,"marginalCost":0.48,"basis":"neutral","balanceKwh":null,"energyDataThrough":"2026-09-23T12:00:00Z"},"currentBill":null"#)
        let response = try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data((populated + "}").utf8))
        #expect(response.activeLoadTiming?.periodName == "Peak")
        #expect(response.activeLoadTiming?.basis == "neutral")
        #expect(response.activeLoadTiming?.balanceKwh == nil)
        #expect(response.activeLoadTiming?.marginalCost == 0.48)
        #expect(response.activeLoadTiming?.energyDataThrough == ISO8601DateFormatter.parse("2026-09-23T12:00:00Z"))

        let unobserved = populated
            .replacingOccurrences(of: #""basis":"neutral""#, with: #""basis":"unobserved""#)
        let unobservedResponse = try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data((unobserved + "}").utf8))
        #expect(unobservedResponse.activeLoadTiming?.basis == "unobserved")
        #expect(unobservedResponse.activeLoadTiming?.balanceKwh == nil)
    }

    @Test("Decodes optional bill load timing periods and source timestamps")
    func decodesBillLoadTiming() throws {
        let fixture = #"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"America/Chicago"},"currentBill":{"estimatedCost":2,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"loadTiming":{"hasTariff":true,"hasCycleData":true,"activeIsCheapest":false,"periods":[{"name":"Peak","marginalCost":0.48,"basis":"buy","cycleNetExportKwh":-3,"isActive":true,"nextStartPhrase":null,"buyRate":0.48,"sellRate":0.12}],"pricingPeriods":[{"name":"Peak","marginalCost":0.48,"basis":"buy","cycleNetExportKwh":-3,"isActive":true,"nextStartPhrase":null,"buyRate":0.48,"sellRate":0.12},{"name":"Off peak","marginalCost":0.12,"basis":"sell","cycleNetExportKwh":10,"isActive":false,"nextStartPhrase":"in 2 hours","buyRate":0.2,"sellRate":0.12}],"nextCheaper":{"name":"Off peak","marginalCost":0.12,"phrase":"in 2 hours"},"nextCheaperPhrase":"in 2 hours","nextStartPhraseByKey":{"off-peak":"in 2 hours"}},"sources":{"calculatedAt":"2026-09-23T12:34:56.123Z","energyDataThrough":"2026-09-23T12:00:00Z"}}"#
        let response = try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(fixture.utf8))
        #expect(response.loadTiming?.hasTariff == true)
        #expect(response.loadTiming?.periods.count == 1)
        #expect(response.loadTiming?.pricingPeriods.count == 2)
        #expect(response.loadTiming?.periods[0].isActive == true)
        #expect(response.loadTiming?.nextCheaper?.name == "Off peak")
        #expect(response.loadTiming?.nextStartPhraseByKey["off-peak"] == "in 2 hours")
        #expect(response.sources.calculatedAt == ISO8601DateFormatter.parse("2026-09-23T12:34:56.123Z"))
        #expect(response.sources.energyDataThrough == ISO8601DateFormatter.parse("2026-09-23T12:00:00Z"))
    }

    @Test("Decodes tariff timeline segments and supports cached payloads without a timeline")
    func decodesTariffTimelineAndLegacyPayload() throws {
        let fixture = #"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"America/Chicago"},"currentBill":{"estimatedCost":2,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"loadTiming":{"hasTariff":true,"hasCycleData":true,"activeIsCheapest":false,"periods":[],"pricingPeriods":[],"tariffTimeline":[{"start":"2026-09-23T23:30:00.125Z","end":"2026-09-24T00:00:00.875Z","periodKey":"off-peak","name":"Off peak","buyRate":0.2134,"sellRate":0.0712}],"nextCheaper":null,"nextCheaperPhrase":null,"nextStartPhraseByKey":{}},"sources":{"calculatedAt":"2026-09-23T12:34:56.123Z","energyDataThrough":null}}"#
        let response = try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(fixture.utf8))
        let segment = try #require(response.loadTiming?.tariffTimeline.first)
        #expect(segment.start == ISO8601DateFormatter.parse("2026-09-23T23:30:00.125Z"))
        #expect(segment.end == ISO8601DateFormatter.parse("2026-09-24T00:00:00.875Z"))
        #expect(segment.periodKey == "off-peak")
        #expect(segment.name == "Off peak")
        #expect(segment.buyRate == 0.2134)
        #expect(segment.sellRate == 0.0712)

        let emptyTimeline = fixture.replacingOccurrences(
            of: #""tariffTimeline":[{"start":"2026-09-23T23:30:00.125Z","end":"2026-09-24T00:00:00.875Z","periodKey":"off-peak","name":"Off peak","buyRate":0.2134,"sellRate":0.0712}]"#,
            with: #""tariffTimeline":[]"#
        )
        let emptyResponse = try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(emptyTimeline.utf8))
        #expect(emptyResponse.loadTiming?.tariffTimeline == [])

        let cached = fixture.replacingOccurrences(of: #","tariffTimeline":[{"start":"2026-09-23T23:30:00.125Z","end":"2026-09-24T00:00:00.875Z","periodKey":"off-peak","name":"Off peak","buyRate":0.2134,"sellRate":0.0712}]"#, with: "")
        let legacyResponse = try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(cached.utf8))
        #expect(legacyResponse.loadTiming?.tariffTimeline == [])
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
        #expect(response.loadTiming == nil)
        #expect(response.currentBill.estimatedCost == nil)
        #expect(response.sources.energyDataThrough == nil)
        #expect(response.currentBill.periods == [Period(tariffName: "Residential", periodName: "Off peak", netGridKwh: -1.25, cost: -0.12)])
        #expect(response.currentBill.cycleStart == ISO8601DateFormatter.parse("2026-09-01T00:00:00.000Z"))
        #expect(response.currentBill.cycleEnd == ISO8601DateFormatter.parse("2026-10-01T00:00:00Z"))
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
