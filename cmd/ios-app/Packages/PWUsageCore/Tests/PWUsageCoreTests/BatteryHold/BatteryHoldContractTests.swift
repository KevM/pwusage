import Foundation
@testable import PWUsageCore
import Testing

@Suite("Battery hold contract")
struct BatteryHoldContractTests {
    static let holdJSON = #"{"id":1,"site_id":"site-1","status":"active","mode":"auto","original_reserve":20,"# +
        #""target_reserve":80,"created_at":"2026-10-02T12:00:00.000Z","# +
        #""safety_expires_at":"2026-10-02T20:00:00.000Z","cancelled_observed_reserve":null}"#

    struct ReserveBandCase {
        let charge: Double
        let target: Int
        let requiresChoice: Bool
    }

    @Test("Reserve planning matches every website boundary", arguments: [
        ReserveBandCase(charge: 0.0, target: 0, requiresChoice: false),
        ReserveBandCase(charge: 79.9, target: 79, requiresChoice: false),
        ReserveBandCase(charge: 80.0, target: 80, requiresChoice: false),
        ReserveBandCase(charge: 80.1, target: 80, requiresChoice: false),
        ReserveBandCase(charge: 85.0, target: 80, requiresChoice: false),
        ReserveBandCase(charge: 85.1, target: 100, requiresChoice: true),
        ReserveBandCase(charge: 94.9, target: 100, requiresChoice: true),
        ReserveBandCase(charge: 95.0, target: 100, requiresChoice: false),
        ReserveBandCase(charge: 100.0, target: 100, requiresChoice: false)
    ])
    func reserveBands(_ sample: ReserveBandCase) throws {
        let plan = try #require(BatteryHoldReservePlan.make(stateOfCharge: sample.charge))
        #expect(plan.target == sample.target)
        #expect(plan.requiresChoice == sample.requiresChoice)
    }

    @Test("Invalid charge cannot enable a hold", arguments: [-1.0, 101.0, Double.nan, Double.infinity])
    func invalidCharge(_ charge: Double) {
        #expect(BatteryHoldReservePlan.make(stateOfCharge: charge) == nil)
    }

    @Test("Timer bounds and payload omission are explicit")
    func choices() throws {
        #expect(BatteryHoldChoice(mode: .timer, durationHours: 0).isValid == false)
        #expect(BatteryHoldChoice(mode: .timer, durationHours: 25).isValid == false)
        #expect(BatteryHoldChoice(mode: .timer, durationHours: 24).isValid)
        let data = try JSONEncoder().encode(BatteryHoldCommand.park(.init(mode: .auto)))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(json == ["action": "park", "mode": "auto"])
    }

    @Test("Hold and persisted cancellation decode with site validation")
    func decodesState() throws {
        let notice = Self.holdJSON.replacingOccurrences(of: "\"active\"", with: "\"cancelled\"")
            .replacingOccurrences(of: "\"cancelled_observed_reserve\":null", with: "\"cancelled_observed_reserve\":45")
        let response = try MobileContractDecoder.make().decode(
            BatteryHoldResponse.self,
            from: Data("{\"hold\":\(Self.holdJSON),\"notice\":\(notice)}".utf8)
        )
        #expect(try response.validating(siteID: "site-1").hold?.originalReserve == 20)
        #expect(response.notice?.cancelledObservedReserve == 45)
        #expect(throws: PWUsageAPIError.invalidResponse) { try response.validating(siteID: "other") }
    }

    @Test("Malformed active reserves fail closed")
    func rejectsMalformedReserves() throws {
        let body = Self.holdJSON.replacingOccurrences(of: "\"target_reserve\":80", with: "\"target_reserve\":180")
        let response = try MobileContractDecoder.make().decode(
            BatteryHoldResponse.self,
            from: Data("{\"hold\":\(body),\"notice\":null}".utf8)
        )
        #expect(throws: PWUsageAPIError.invalidResponse) { try response.validating(siteID: "site-1") }
    }

    @Test("An empty response cannot masquerade as idle status")
    func rejectsMissingState() {
        #expect(throws: (any Error).self) {
            try MobileContractDecoder.make().decode(BatteryHoldResponse.self, from: Data("{}".utf8))
        }
    }

    @Test("Monitoring decodes alongside an existing hold and remains optional")
    func monitoringDecoding() throws {
        let monitoring = """
        {"phase":"load_running","checked_at":"2026-10-02T10:16:00Z","next_check_at":"2026-10-02T10:30:00Z",
         "sampled_at":"2026-10-02T10:15:00Z","estimated_load_w":9000}
        """
        let body = Self.holdJSON.dropLast() + ",\"monitoring\":\(monitoring)}"
        let hold = try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(body.utf8))
        #expect(hold.monitoring?.estimatedLoadW == 9000)
        #expect(hold.monitoring?.phase == .loadRunning)
        let oldHold = try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(Self.holdJSON.utf8))
        #expect(oldHold.monitoring == nil)
    }
}
