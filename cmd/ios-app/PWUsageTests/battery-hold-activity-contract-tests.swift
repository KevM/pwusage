import Foundation
@testable import PWUsage
import Testing

@Suite("Battery hold Live Activity contract")
struct BatteryHoldActivityContractTests {
    /// The example in docs/battery-hold-live-activity-delivery.md, as the server sends it.
    static let deliveryDocExample = """
    { "schema": 1, "holdId": 7, "status": "active", "mode": "auto", "phase": "load_running",
      "originalReserve": 20, "targetReserve": 100, "estimatedLoadW": 7200,
      "startedAt": 813751200, "safetyExpiresAt": 813780000, "checkedAt": 813752102,
      "nextCheckAt": 813753000, "endedAt": null, "restoreReason": null, "cancelledObservedReserve": null }
    """

    /// ActivityKit decodes content-state with a default `JSONDecoder`.
    private func decode(_ json: String) throws -> BatteryHoldActivityAttributes.ContentState {
        try JSONDecoder().decode(BatteryHoldActivityAttributes.ContentState.self, from: Data(json.utf8))
    }

    @Test("Decodes the delivery doc's server payload with reference-date seconds")
    func decodesServerExample() throws {
        let state = try decode(Self.deliveryDocExample)
        #expect(state.schema == 1)
        #expect(state.holdId == 7)
        #expect(state.status == .active)
        #expect(state.mode == .auto)
        #expect(state.phase == .loadRunning)
        #expect(state.originalReserve == 20)
        #expect(state.targetReserve == 100)
        #expect(state.estimatedLoadW == 7200)
        // 813751200 s after 2001-01-01T00:00:00Z is 2026-10-15T10:00:00Z.
        #expect(state.startedAt == ISO8601DateFormatter().date(from: "2026-10-15T10:00:00Z"))
        #expect(state.safetyExpiresAt.timeIntervalSince(state.startedAt) == 8 * 3600)
        #expect(state.checkedAt == Date(timeIntervalSinceReferenceDate: 813752102))
        #expect(state.nextCheckAt == Date(timeIntervalSinceReferenceDate: 813753000))
        #expect(state.endedAt == nil)
        #expect(state.restoreReason == nil)
        #expect(state.cancelledObservedReserve == nil)
    }

    @Test("Decodes the home load range, and its absence from older payloads")
    func decodesLoadRange() throws {
        let state = try decode(Self.deliveryDocExample.replacingOccurrences(of: #""cancelledObservedReserve": null }"#, with:
            #""cancelledObservedReserve": null, "sampledAt": 813751800, "baselineLoadW": 1200, "homeLoadW": 8400, "peakLoadW": 9100 }"#))
        #expect(state.sampledAt == Date(timeIntervalSinceReferenceDate: 813751800))
        #expect(state.baselineLoadW == 1200)
        #expect(state.homeLoadW == 8400)
        #expect(state.peakLoadW == 9100)
        let older = try decode(Self.deliveryDocExample)
        #expect(older.homeLoadW == nil && older.sampledAt == nil)
    }

    @Test("Decodes the live battery charge, and its absence from older payloads")
    func decodesBatteryPercent() throws {
        let state = try decode(Self.deliveryDocExample.replacingOccurrences(of: #""cancelledObservedReserve": null }"#, with:
            #""cancelledObservedReserve": null, "batteryPercent": 82.4 }"#))
        #expect(state.batteryPercent == 82.4)
        #expect(try decode(Self.deliveryDocExample).batteryPercent == nil)
        let data = try JSONEncoder().encode(state)
        #expect(try JSONDecoder().decode(BatteryHoldActivityAttributes.ContentState.self, from: data) == state)
    }

    @Test("Decodes terminal payloads: restored and cancelled")
    func decodesTerminal() throws {
        let restored = try decode("""
        { "schema": 1, "holdId": 7, "status": "restored", "mode": "timer", "phase": null,
          "originalReserve": 20, "targetReserve": 80, "estimatedLoadW": null,
          "startedAt": 813751200, "safetyExpiresAt": 813780000, "checkedAt": null,
          "nextCheckAt": null, "endedAt": 813760000, "restoreReason": "timer_elapsed", "cancelledObservedReserve": null }
        """)
        #expect(restored.status == .restored)
        #expect(restored.mode == .timer)
        #expect(restored.phase == nil)
        #expect(restored.restoreReason == .timerElapsed)
        #expect(restored.endedAt == Date(timeIntervalSinceReferenceDate: 813760000))

        let cancelled = try decode("""
        { "schema": 1, "holdId": 7, "status": "cancelled", "mode": "auto", "phase": "watching",
          "originalReserve": 20, "targetReserve": 80, "estimatedLoadW": null,
          "startedAt": 813751200, "safetyExpiresAt": 813780000, "checkedAt": 813752102,
          "nextCheckAt": 813753000, "endedAt": 813752200, "restoreReason": "reserve_changed", "cancelledObservedReserve": 45 }
        """)
        #expect(cancelled.status == .cancelled)
        #expect(cancelled.restoreReason == .reserveChanged)
        #expect(cancelled.cancelledObservedReserve == 45)
    }

    @Test("Unknown values from a newer server degrade instead of dropping the update")
    func forwardCompatible() throws {
        let state = try decode("""
        { "schema": 2, "holdId": 7, "status": "paused", "mode": "solar", "phase": "something_new",
          "originalReserve": 20, "targetReserve": 100, "startedAt": 813751200, "safetyExpiresAt": 813780000,
          "restoreReason": "new_reason", "extra": { "nested": true } }
        """)
        #expect(state.schema == 2)
        #expect(state.status == .unknown)
        #expect(state.mode == .auto)
        #expect(state.phase == .unknown)
        #expect(state.restoreReason == .unknown)
        #expect(state.checkedAt == nil)
    }

    @Test("Missing required fields fail rather than inventing a hold")
    func requiredFields() {
        #expect(throws: (any Error).self) {
            try decode(#"{ "schema": 1, "holdId": 7, "status": "active" }"#)
        }
    }

    @Test("Local encoding round trips with the same keys the server uses")
    func roundTrip() throws {
        let state = try decode(Self.deliveryDocExample)
        let data = try JSONEncoder().encode(state)
        #expect(try JSONDecoder().decode(BatteryHoldActivityAttributes.ContentState.self, from: data) == state)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["phase"] as? String == "load_running")
        #expect(object["status"] as? String == "active")
        #expect(object["startedAt"] as? Double == 813751200)
    }

    @Test("Builds the same state the server would send from an app hold")
    func fromHold() throws {
        let start = Date(timeIntervalSinceReferenceDate: 813751200)
        var hold = BatteryHold(
            id: 7, siteID: "site-1", status: .active, mode: .auto, originalReserve: 20, targetReserve: 100,
            createdAt: start, safetyExpiresAt: start.addingTimeInterval(8 * 3600), cancelledObservedReserve: nil
        )
        hold.monitoring = BatteryHoldMonitoring(
            phase: .loadRunning, checkedAt: Date(timeIntervalSinceReferenceDate: 813752102),
            nextCheckAt: Date(timeIntervalSinceReferenceDate: 813753000), sampledAt: nil, estimatedLoadW: 7200
        )
        #expect(BatteryHoldActivityAttributes.ContentState(hold: hold) == (try decode(Self.deliveryDocExample)))
        let monitoring = try MobileContractDecoder.make().decode(BatteryHoldMonitoring.self, from: Data("""
        {"phase":"load_running","checked_at":"2026-10-15T10:15:02.000Z","next_check_at":"2026-10-15T10:30:00.000Z",
         "sampled_at":"2026-10-15T10:10:00.000Z","estimated_load_w":7200,"baseline_load_w":1200,"home_load_w":8400,"peak_load_w":9100,"battery_percent":82.4}
        """.utf8))
        hold.monitoring = monitoring
        let state = BatteryHoldActivityAttributes.ContentState(hold: hold)
        #expect(state.sampledAt == monitoring.sampledAt)
        #expect(state.baselineLoadW == 1200 && state.homeLoadW == 8400 && state.peakLoadW == 9100)
        #expect(state.batteryPercent == 82.4)
    }
}
