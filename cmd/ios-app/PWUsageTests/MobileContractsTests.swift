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

    @Test("Suppresses a battery charge reading older than the two-hour rule")
    func suppressesStaleStateOfCharge() throws {
        let response = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .stamped(LiveFixture.timestamp(-3 * 3600)))
        )
        #expect(response.stateOfCharge == nil)
    }

    @Test("Suppresses an undated battery charge reading")
    func suppressesUndatedStateOfCharge() throws {
        let absent = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .absent)
        )
        #expect(absent.stateOfCharge == nil)

        let nulled = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: nil)
        )
        #expect(nulled.stateOfCharge == nil)
    }

    @Test("Suppresses a battery charge reading stamped in the future")
    func suppressesFutureStateOfCharge() throws {
        let response = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .stamped(LiveFixture.timestamp(60)))
        )
        #expect(response.stateOfCharge == nil)
    }

    @Test("Keeps a battery charge reading taken ten minutes ago")
    func keepsRecentStateOfCharge() throws {
        let response = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .stamped(LiveFixture.timestamp(-10 * 60)))
        )
        #expect(response.stateOfCharge == 72)
    }

    @Test("Suppresses an out-of-range battery charge reading")
    func suppressesOutOfRangeStateOfCharge() throws {
        let high = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "150", stateOfChargeAt: .stamped(LiveFixture.timestamp(-10 * 60)))
        )
        #expect(high.stateOfCharge == nil)

        let negative = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "-1", stateOfChargeAt: .stamped(LiveFixture.timestamp(-10 * 60)))
        )
        #expect(negative.stateOfCharge == nil)
    }

    @Test("Keeps a battery charge reading at exactly the two-hour edge and suppresses one second past it")
    func appliesInclusiveStateOfChargeAgeLimit() throws {
        let atTheEdge = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .stamped(LiveFixture.timestamp(-2 * 3600)))
        )
        #expect(atTheEdge.stateOfCharge == 72)

        let oneSecondPast = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .stamped(LiveFixture.timestamp(-2 * 3600 - 1)))
        )
        #expect(oneSecondPast.stateOfCharge == nil)
    }

    @Test("Decodes the live power values a payload carries, including negative ones")
    func decodesLivePowerValues() throws {
        let response = try LiveFixture.decode(
            LiveFixture.payload(stateOfCharge: "72", stateOfChargeAt: .stamped(LiveFixture.timestamp(-10 * 60)))
        )
        #expect(response.live.solarPower == 1200)
        #expect(response.live.loadPower == 900)
        #expect(response.live.gridPower == 0)
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

    /// JSON cannot carry NaN or infinity, so a decoder that reads them from strings
    /// stands in for any non-conforming source the validation exists to catch.
    private static func nonConformingDecoder() -> JSONDecoder {
        let decoder = MobileContractDecoder.make()
        decoder.nonConformingFloatDecodingStrategy = .convertFromString(positiveInfinity: "inf", negativeInfinity: "-inf", nan: "nan")
        return decoder
    }

    private static let billBase = #"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"UTC"},"sources":{"calculatedAt":"2026-09-23T12:34:56Z","energyDataThrough":null},"currentBill":{"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","#

    @Test("A bill with a non-finite cost or rate is rejected", arguments: [
        billBase + #""estimatedCost":"nan","periods":[]}}"#,
        billBase + #""estimatedCost":1,"periods":[{"tariffName":"R","periodName":"Peak","netGridKwh":1,"cost":"inf"}]}}"#,
        billBase + #""estimatedCost":1,"periods":[]},"loadTiming":{"hasTariff":true,"hasCycleData":true,"activeIsCheapest":false,"periods":[{"name":"Peak","marginalCost":"-inf","basis":"buy","cycleNetExportKwh":0,"isActive":true,"nextStartPhrase":null,"buyRate":0.3,"sellRate":0.1}],"pricingPeriods":[]}}"#,
        billBase + #""estimatedCost":1,"periods":[]},"loadTiming":{"hasTariff":true,"hasCycleData":true,"activeIsCheapest":false,"periods":[],"pricingPeriods":[{"name":"Peak","marginalCost":0.3,"basis":"buy","cycleNetExportKwh":0,"isActive":true,"nextStartPhrase":null,"buyRate":"nan","sellRate":0.1}]}}"#,
        billBase + #""estimatedCost":1,"periods":[]},"loadTiming":{"hasTariff":true,"hasCycleData":true,"activeIsCheapest":false,"periods":[],"pricingPeriods":[],"tariffTimeline":[{"start":"2026-09-23T23:30:00Z","end":"2026-09-24T00:00:00Z","periodKey":"p","name":"Peak","buyRate":0.3,"sellRate":"inf"}]}}"#,
        billBase + #""estimatedCost":1,"periods":[]},"loadTiming":{"hasTariff":true,"hasCycleData":true,"activeIsCheapest":false,"periods":[],"pricingPeriods":[],"nextCheaper":{"name":"Off","marginalCost":"nan","phrase":"soon"}}}"#,
    ])
    func rejectsNonFiniteBillAmounts(fixture: String) throws {
        let response = try Self.nonConformingDecoder().decode(MobileBillResponse.self, from: Data(fixture.utf8))
        #expect(throws: MobileBillResponse.ContractError.invalidAmount) { try response.validating(siteID: "site-1") }
    }

    @Test("Negative rates and costs are valid: the server prices negative buy and sell rates")
    func acceptsNegativeRatesAndCosts() throws {
        let bill = Self.billBase + #""estimatedCost":-4.5,"periods":[{"tariffName":"R","periodName":"Export","netGridKwh":-3,"cost":-0.3}]},"loadTiming":{"hasTariff":true,"hasCycleData":true,"activeIsCheapest":true,"periods":[{"name":"Export","marginalCost":-0.1,"basis":"sell","cycleNetExportKwh":3,"isActive":true,"nextStartPhrase":null,"buyRate":-0.1,"sellRate":-0.04}],"pricingPeriods":[]}}"#
        let response = try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(bill.utf8))
        #expect(try response.validating(siteID: "site-1") == response)
        let tariffs = try MobileContractDecoder.make().decode(MobileTariffsResponse.self, from: Data(TariffSheetTests.fixture.replacingOccurrences(of: #""buyRate":0.3"#, with: #""buyRate":-0.3"#).utf8))
        #expect(try tariffs.validating(siteID: "a") == tariffs)
    }

    @Test("A live response with a non-finite bill amount or rate is rejected", arguments: [
        #""currentBill":{"estimatedCost":"inf","currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]}"#,
        #""currentBill":{"estimatedCost":1,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[{"tariffName":"R","periodName":"Peak","netGridKwh":1,"cost":"nan"}]}"#,
        #""activeLoadTiming":{"periodName":"Peak","buyRate":"nan","sellRate":0.1,"marginalCost":null,"basis":"buy","balanceKwh":null,"energyDataThrough":null}"#,
        #""activeLoadTiming":{"periodName":"Peak","buyRate":0.3,"sellRate":0.1,"marginalCost":"-inf","basis":"buy","balanceKwh":null,"energyDataThrough":null}"#,
    ])
    func rejectsNonFiniteLiveAmounts(field: String) throws {
        let fixture = #"{"version":1,"site":{"id":"site-1","name":"Home","timezone":"UTC","localDate":"2026-09-23"},"live":{"solarPower":0,"loadPower":0,"batteryPower":0,"gridPower":0},"today":{"homeKwh":1,"solarKwh":1,"gridNetKwh":0,"batteryNetKwh":0},"todayComplete":false,"sources":{"energyDataThrough":null},"# + field + "}"
        let response = try Self.nonConformingDecoder().decode(MobileLiveResponse.self, from: Data(fixture.utf8))
        #expect(throws: MobileLiveResponse.ContractError.invalidAmount) { try response.validating(siteID: "site-1") }
    }

    @Test("A tariff period with a non-finite rate is rejected")
    func rejectsNonFiniteTariffRate() throws {
        let fixture = TariffSheetTests.fixture.replacingOccurrences(of: #""sellRate":0.1"#, with: #""sellRate":"nan""#)
        let response = try Self.nonConformingDecoder().decode(MobileTariffsResponse.self, from: Data(fixture.utf8))
        #expect(throws: PWUsageAPIError.invalidResponse) { try response.validating(siteID: "a") }
    }

    @Test("A planning context stamped ahead of a slow device clock still validates")
    func planningContextToleratesClockBehindServer() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        // Thirty minutes ahead of this device. `asOf` is the server's stamp, so an
        // `asOf` in the device's future means the *device* is behind -- a fast clock
        // would make `asOf` look older, which the positive bound already accepted.
        let response = Self.makePlanningContext(siteID: "site-a", asOf: now.addingTimeInterval(30 * 60))
        #expect(throws: Never.self) { try response.validating(siteID: "site-a", now: now) }
    }

    @Test("A planning context stamped absurdly ahead is still rejected")
    func planningContextRejectsAbsurdFutureAsOf() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let response = Self.makePlanningContext(siteID: "site-a", asOf: now.addingTimeInterval(365 * 24 * 60 * 60))
        #expect(throws: MobileLoadPlanningContextResponse.ContractError.timestampSkew) {
            try response.validating(siteID: "site-a", now: now)
        }
    }

    /// Skew and a malformed payload used to share `invalidSource`, so the UI could
    /// not tell "fix your clock" from "this will never parse". Only the first is
    /// something the person holding the phone can act on, so they must not share
    /// an error that becomes advice.
    @Test("A stale timestamp is clock skew, not a malformed payload")
    func planningContextSeparatesStalenessFromMalformedPayload() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let stale = Self.makePlanningContext(siteID: "site-a", asOf: now.addingTimeInterval(-48 * 60 * 60))
        #expect(throws: MobileLoadPlanningContextResponse.ContractError.timestampSkew) {
            try stale.validating(siteID: "site-a", now: now)
        }

        let badUnits = Self.makePlanningContext(
            siteID: "site-a",
            asOf: now.addingTimeInterval(-60),
            power: "W"
        )
        #expect(throws: MobileLoadPlanningContextResponse.ContractError.invalidSource) {
            try badUnits.validating(siteID: "site-a", now: now)
        }

        let badZone = Self.makePlanningContext(
            siteID: "site-a",
            asOf: now.addingTimeInterval(-60),
            timeZone: "Not/AZone"
        )
        #expect(throws: MobileLoadPlanningContextResponse.ContractError.invalidSource) {
            try badZone.validating(siteID: "site-a", now: now)
        }
    }

    /// `coverage` is the share of usable days that voted for a slot, not the 90%
    /// interval rule (which the server applies before a day/slot may vote). A real
    /// site with 13 usable days and 10 late-evening votes (0.77) was rejected
    /// wholesale as malformed, so the forecast never appeared.
    @Test("A slot with five or more day votes validates whatever share of days voted")
    func planningContextAcceptsSlotVotedByFewerThanAllUsableDays() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let response = Self.makePlanningContext(
            siteID: "site-a",
            asOf: now.addingTimeInterval(-60),
            usableDayCount: 13,
            slot: { index in
                index >= 45
                    ? .init(localMinute: index * 30, homeKw: 1, batteryNetChargeKw: 0, sampleCount: 10, coverage: 10.0 / 13.0)
                    : .init(localMinute: index * 30, homeKw: 1, batteryNetChargeKw: 0, sampleCount: 13, coverage: 1)
            }
        )
        #expect(throws: Never.self) { try response.validating(siteID: "site-a", now: now) }
    }

    @Test("A slot carrying a value from fewer than five day votes is still rejected")
    func planningContextRejectsValuedSlotWithTooFewVotes() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let response = Self.makePlanningContext(
            siteID: "site-a",
            asOf: now.addingTimeInterval(-60),
            slot: { index in
                .init(localMinute: index * 30, homeKw: 1, batteryNetChargeKw: 0, sampleCount: index == 0 ? 4 : 14, coverage: 1)
            }
        )
        #expect(throws: MobileLoadPlanningContextResponse.ContractError.invalidSource) {
            try response.validating(siteID: "site-a", now: now)
        }
    }

    private static func planningContextJSON(slot: (Int) -> String) -> Data {
        let slots = (0..<48).map(slot).joined(separator: ",")
        return Data(#"{"version":1,"site":{"id":"site-a","timezone":"America/Chicago"},"units":{"power":"kW","localMinute":"minute-of-day"},"asOf":"2026-10-18T15:00:00Z","availability":"available","usableDayCount":14,"historyStart":"2026-10-04T05:00:00Z","historyEnd":"2026-10-18T05:00:00Z","slots":[\#(slots)]}"#.utf8)
    }

    @Test("planningContextDecodesGridHistory")
    func planningContextDecodesGridHistory() throws {
        let data = Self.planningContextJSON { index in
            #"{"localMinute":\#(index * 30),"homeKw":1,"batteryNetChargeKw":0,"sampleCount":14,"coverage":1,"gridNetExportKw":2.5,"cautiousGridNetExportKw":1.25,"solarKw":3}"#
        }
        let response = try MobileContractDecoder.make().decode(MobileLoadPlanningContextResponse.self, from: data)
        let validated = try response.validating(siteID: "site-a", now: try #require(ISO8601DateFormatter.parse("2026-10-18T15:01:00Z")))

        #expect(validated.slots[0].gridNetExportKw == 2.5)
        #expect(validated.slots[0].cautiousGridNetExportKw == 1.25)
        #expect(validated.slots[0].solarKw == 3)
        let context = try #require(validated.estimatorContext)
        #expect(context.hasGridHistory)
        #expect(context.slots[0].gridNetExportKw == 2.5)
        #expect(context.slots[0].cautiousGridNetExportKw == 1.25)
    }

    @Test("planningContextWithoutGridHistoryStillDecodes")
    func planningContextWithoutGridHistoryStillDecodes() throws {
        let data = Self.planningContextJSON { index in
            #"{"localMinute":\#(index * 30),"homeKw":1,"batteryNetChargeKw":0,"sampleCount":14,"coverage":1}"#
        }
        let response = try MobileContractDecoder.make().decode(MobileLoadPlanningContextResponse.self, from: data)
        let validated = try response.validating(siteID: "site-a", now: try #require(ISO8601DateFormatter.parse("2026-10-18T15:01:00Z")))

        #expect(validated.slots[0].gridNetExportKw == nil)
        let context = try #require(validated.estimatorContext)
        #expect(!context.hasGridHistory)
    }

    @Test("A non-finite grid history value is rejected")
    func planningContextRejectsNonFiniteGridHistory() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let response = Self.makePlanningContext(
            siteID: "site-a",
            asOf: now.addingTimeInterval(-60),
            slot: { index in
                var slot = MobileLoadPlanningContextResponse.Slot(localMinute: index * 30, homeKw: 1, batteryNetChargeKw: 0, sampleCount: 14, coverage: 1)
                slot.cautiousGridNetExportKw = index == 3 ? .infinity : 1
                return slot
            }
        )
        #expect(throws: MobileLoadPlanningContextResponse.ContractError.invalidSource) {
            try response.validating(siteID: "site-a", now: now)
        }
    }

    /// Satisfies every clause of `validating`, so a test can vary `asOf` alone.
    /// `DashboardCoordinatorTests` needs the same fixture but keeps its own copy.
    private static func makePlanningContext(
        siteID: String,
        asOf: Date,
        power: String = "kW",
        timeZone: String = "UTC",
        usableDayCount: Int = 14,
        slot: (Int) -> MobileLoadPlanningContextResponse.Slot = { index in
            .init(localMinute: index * 30, homeKw: 1, batteryNetChargeKw: 0, sampleCount: 14, coverage: 1)
        }
    ) -> MobileLoadPlanningContextResponse {
        MobileLoadPlanningContextResponse(
            version: 1,
            site: .init(id: siteID, timezone: timeZone),
            units: .init(power: power, localMinute: "minute-of-day"),
            asOf: asOf,
            availability: .available,
            unavailableReason: nil,
            usableDayCount: usableDayCount,
            historyStart: asOf.addingTimeInterval(-14 * 24 * 60 * 60),
            historyEnd: asOf.addingTimeInterval(-60),
            slots: (0..<48).map(slot)
        )
    }
}

private enum LiveFixture {
    static let now = Date(timeIntervalSince1970: 1_000_000)

    /// A `stateOfChargeAt` fixture value: an ISO-8601 stamp, `nil` for an explicit JSON `null`,
    /// or `.absent` to leave the key out of `sources` entirely.
    enum StateOfChargeAt {
        case stamped(String)
        case absent
    }

    static func timestamp(_ offset: TimeInterval) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: now.addingTimeInterval(offset))
    }

    static func payload(stateOfCharge: String, stateOfChargeAt: StateOfChargeAt?) -> String {
        let source: String
        switch stateOfChargeAt {
        case .some(.stamped(let stamp)):
            source = "\"stateOfChargeAt\":\"\(stamp)\""
        case .some(.absent):
            source = ""
        case nil:
            source = "\"stateOfChargeAt\":null"
        }
        return """
        {"version":1,"site":{"id":"site-1","name":"Home","timezone":"UTC","localDate":"1970-01-12"},\
        "live":{"solarPower":1200,"loadPower":900,"batteryPower":-300,"gridPower":0},\
        "stateOfCharge":\(stateOfCharge),\
        "today":{"homeKwh":12,"solarKwh":8,"gridNetKwh":4,"batteryNetKwh":1},\
        "todayComplete":true,"currentBill":null,\
        "sources":{"liveStatusAt":null,"energyDataThrough":null\(source.isEmpty ? "" : "," + source)}}
        """
    }

    static func decode(_ json: String) throws -> MobileLiveResponse {
        try MobileContractDecoder.make(now: { now }).decode(MobileLiveResponse.self, from: Data(json.utf8))
    }
}

private extension ISO8601DateFormatter {
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = value.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
