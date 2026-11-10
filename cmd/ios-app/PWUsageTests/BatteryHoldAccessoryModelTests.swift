import Foundation
@testable import PWUsage
import Testing

@Suite("Battery Saver tab accessory")
struct BatteryHoldAccessoryModelTests {
    private let now = Date(timeIntervalSince1970: 1_790_000_000)

    private func state(
        mode: String = "auto", monitoring: String? = nil, isCurrent: Bool = true, hasHold: Bool = true
    ) throws -> BatteryHoldState {
        let hold: BatteryHold? = if hasHold {
            try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(Self.json(mode, monitoring).utf8))
        } else {
            nil
        }
        return BatteryHoldState(response: .init(hold: hold, notice: nil), isCurrent: isCurrent, fetchedAt: now)
    }

    private static func json(_ mode: String, _ monitoring: String?) -> String {
        let base = #"{"id":1,"site_id":"site-1","status":"active","mode":"\#(mode)","original_reserve":20,"#
            + #""target_reserve":80,"created_at":"2026-10-02T12:00:00.000Z","#
            + #""safety_expires_at":"2026-10-02T20:00:00.000Z","cancelled_observed_reserve":null"#
        return base + (monitoring.map { ",\"monitoring\":\($0)" } ?? "") + "}"
    }

    private func monitoring(sampledAt: Date, baseline: Double? = 1200, home: Double? = 1800) -> String {
        let format = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let stamp = sampledAt.formatted(format)
        return #"{"phase":"watching","checked_at":"\#(stamp)","next_check_at":"\#(stamp)","sampled_at":"\#(stamp)","#
            + #""baseline_load_w":\#(baseline.map { "\($0)" } ?? "null"),"#
            + #""home_load_w":\#(home.map { "\($0)" } ?? "null")}"#
    }

    @Test("Shows the hold level, detection level and current home use")
    func fullDetails() throws {
        let model = try #require(BatteryHoldAccessoryModel(
            state: state(monitoring: monitoring(sampledAt: now.addingTimeInterval(-60))), now: now))
        #expect(model.title == "Battery Saver · 80%")
        #expect(model.detail == "Home 1.8 kW · job at 2.2 kW")
    }

    @Test("Appears only for a current, active hold")
    func availability() throws {
        #expect(try BatteryHoldAccessoryModel(state: state(hasHold: false), now: now) == nil)
        #expect(try BatteryHoldAccessoryModel(state: state(isCurrent: false), now: now) == nil)
        #expect(try BatteryHoldAccessoryModel(state: state(), now: now.addingTimeInterval(121)) == nil)
    }

    @Test("Without a reading it still says the hold level and omits the numbers")
    func noReading() throws {
        let model = try #require(BatteryHoldAccessoryModel(state: state(), now: now))
        #expect(model.title == "Battery Saver · 80%")
        #expect(model.detail == nil)
    }

    @Test("A stale reading is not shown as current home use")
    func staleReading() throws {
        let stale = monitoring(sampledAt: now.addingTimeInterval(-21 * 60))
        let model = try #require(BatteryHoldAccessoryModel(state: state(monitoring: stale), now: now))
        #expect(model.detail == nil)
    }

    @Test("A timer hold has no detection level")
    func timerMode() throws {
        let reading = monitoring(sampledAt: now.addingTimeInterval(-60), baseline: nil)
        let model = try #require(BatteryHoldAccessoryModel(state: state(mode: "timer", monitoring: reading), now: now))
        #expect(model.detail == "Home 1.8 kW")
    }

    @Test("The accessibility label reads the same facts and says it opens Battery Saver")
    func accessibility() throws {
        let reading = monitoring(sampledAt: now.addingTimeInterval(-60))
        let model = try #require(BatteryHoldAccessoryModel(state: state(monitoring: reading), now: now))
        #expect(model.accessibilityLabel == "Battery Saver on, held at 80%. "
            + "Home 1.8 kW. A job is detected at 2.2 kW. Open Battery Saver.")
    }
}
