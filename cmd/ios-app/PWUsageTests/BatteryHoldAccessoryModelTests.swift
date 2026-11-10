import Foundation
@testable import PWUsage
import Testing

@Suite("Battery Saver tab accessory")
struct BatteryHoldAccessoryModelTests {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    private func state(isCurrent: Bool = true, hasHold: Bool = true) throws -> BatteryHoldState {
        let hold: BatteryHold? = if hasHold {
            try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(Self.json.utf8))
        } else {
            nil
        }
        return BatteryHoldState(response: .init(hold: hold, notice: nil), isCurrent: isCurrent, fetchedAt: now)
    }

    private static let json = #"{"id":1,"site_id":"site-1","status":"active","mode":"auto","original_reserve":20,"#
        + #""target_reserve":80,"created_at":"2026-10-02T12:00:00.000Z","#
        + #""safety_expires_at":"2026-10-02T20:00:00.000Z","cancelled_observed_reserve":null}"#

    @Test("Says the level the battery is held at")
    func title() throws {
        let model = try #require(BatteryHoldAccessoryModel(state: state(), now: now))
        #expect(model.title == "Battery holding at 80%")
        #expect(model.accessibilityLabel == "Battery holding at 80%. Open Battery Saver.")
    }

    @Test("Appears only for a current, active hold")
    func availability() throws {
        #expect(try BatteryHoldAccessoryModel(state: state(hasHold: false), now: now) == nil)
        #expect(try BatteryHoldAccessoryModel(state: state(isCurrent: false), now: now) == nil)
        #expect(try BatteryHoldAccessoryModel(state: state(), now: now.addingTimeInterval(121)) == nil)
    }
}
