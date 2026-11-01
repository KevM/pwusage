import Foundation
@testable import PWUsage
import Testing

@Suite("Mobile solar history day durations")
struct MobileSolarHistoryDecodingTests {
    @Test("Half-hour daylight-saving transition days decode and synchronize", arguments: ["2026-04-05", "2026-10-04"])
    func halfHourTransitionSynchronizes(day: String) async throws {
        let isFallBack = day == "2026-04-05"
        let start = isFallBack ? "2026-04-04T13:00:00Z" : "2026-10-03T13:30:00Z"
        let expectedSlots = isFallBack ? 294 : 282
        let response = try decode(day: day, start: start, slotCount: expectedSlots)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = SolarHistoryStore(directory: folder)
        let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "lord-howe")
        let dayStart = try #require(ISO8601DateFormatter().date(from: start))

        let result = try await store.sync(
            scope: scope, api: DecodedHistoryAPI(response: response), now: dayStart.addingTimeInterval(86400)
        )

        #expect(result == .synced(timeZone: try #require(TimeZone(identifier: "Australia/Lord_Howe"))))
        let samples = try await store.samples(scope: scope)
        #expect(samples.count == expectedSlots)
        #expect(samples.first?.timestamp == dayStart)
        #expect(samples.last?.timestamp == dayStart.addingTimeInterval(Double(expectedSlots - 1) * 300))
    }

    @Test("Full-hour daylight-saving transition days remain valid", arguments: [false, true])
    func fullHourTransitionDecodes(isSpringForward: Bool) throws {
        let day = isSpringForward ? "2026-03-08" : "2026-11-01"
        let start = isSpringForward ? "2026-03-08T06:00:00Z" : "2026-11-01T05:00:00Z"
        let response = try decode(
            day: day, start: start, slotCount: isSpringForward ? 276 : 300, timeZone: "America/Chicago"
        )
        #expect(response != .disabled)
    }

    @Test("An ordinary day still has 288 slots")
    func ordinaryDayDecodes() throws {
        let response = try decode(day: "2026-10-05", start: "2026-10-04T13:00:00Z", slotCount: 288)
        #expect(response != .disabled)
    }

    @Test("Slot counts must match the site's actual day length", arguments: [0, 281, 283, 288, 294, 300])
    func mismatchedSlotCountsAreRejected(slotCount: Int) {
        #expect(throws: DecodingError.self) {
            try decode(day: "2026-10-04", start: "2026-10-03T13:30:00Z", slotCount: slotCount)
        }
    }

    private func decode(
        day: String, start: String, slotCount: Int, timeZone: String = "Australia/Lord_Howe"
    ) throws -> MobileSolarHistoryResponse {
        let slots = Array(repeating: "1", count: slotCount).joined(separator: ",")
        let json = #"{"version":1,"enabled":true,"timeZone":"\#(timeZone)","days":[{"day":"\#(day)","#
            + #""dayStart":"\#(start)","status":"complete","fetchedAt":"\#(start)","solarWh":[\#(slots)]}]}"#
        return try MobileContractDecoder.make().decode(MobileSolarHistoryResponse.self, from: Data(json.utf8))
    }
}

private struct DecodedHistoryAPI: MobileSolarHistoryDataAPI {
    let response: MobileSolarHistoryResponse

    func fetchSolarHistory(
        siteID: String, from: String, changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse { response }
}
