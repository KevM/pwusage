import Foundation
@testable import PWUsage
import Testing

extension MobileContractsTests {
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
                    ? .init(localMinute: index * 30, homeKw: 1, batteryNetChargeKw: 0,
                            sampleCount: 10, coverage: 10.0 / 13.0)
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
                .init(localMinute: index * 30, homeKw: 1, batteryNetChargeKw: 0,
                      sampleCount: index == 0 ? 4 : 14, coverage: 1)
            }
        )
        #expect(throws: MobileLoadPlanningContextResponse.ContractError.invalidSource) {
            try response.validating(siteID: "site-a", now: now)
        }
    }

    @Test("planningContextDecodesGridHistory")
    func planningContextDecodesGridHistory() throws {
        let data = Self.planningContextJSON { index in
            #"{"localMinute":\#(index * 30),"homeKw":1,"batteryNetChargeKw":0,"sampleCount":14,"#
                + #""coverage":1,"gridNetExportKw":2.5,"cautiousGridNetExportKw":1.25,"solarKw":3}"#
        }
        let response = try MobileContractDecoder.make().decode(MobileLoadPlanningContextResponse.self, from: data)
        let validated = try response.validating(
            siteID: "site-a",
            now: try #require(ISO8601DateFormatter().date(from: "2026-10-18T15:01:00Z"))
        )

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
        let validated = try response.validating(
            siteID: "site-a",
            now: try #require(ISO8601DateFormatter().date(from: "2026-10-18T15:01:00Z"))
        )

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
                var slot = MobileLoadPlanningContextResponse.Slot(localMinute: index * 30, homeKw: 1,
                                                                  batteryNetChargeKw: 0, sampleCount: 14,
                                                                  coverage: 1)
                slot.cautiousGridNetExportKw = index == 3 ? .infinity : 1
                return slot
            }
        )
        #expect(throws: MobileLoadPlanningContextResponse.ContractError.invalidSource) {
            try response.validating(siteID: "site-a", now: now)
        }
    }
}
