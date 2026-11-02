import Foundation
@testable import PWUsage
import Testing

@Suite("Solar History Store fill merge")
struct SolarHistoryStoreMergeTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
    private let now = ISO8601DateFormatter().date(from: "2026-01-10T12:00:00Z") ?? .distantPast

    private func day(_ value: String, solarWh: Double) -> MobileSolarHistoryDay {
        let start = ISO8601DateFormatter().date(from: "\(value)T00:00:00Z") ?? .distantPast
        return MobileSolarHistoryDay(
            day: value, dayStart: start, status: .complete, fetchedAt: now,
            solarWh: Array(repeating: solarWh, count: 288).map(Optional.some))
    }

    private func fill(_ days: [MobileSolarHistoryDay]) -> MobileSolarHistoryFill {
        MobileSolarHistoryFill(timeZone: .gmt, status: .complete, historyStart: "2025-01-01", days: days)
    }

    private func store() -> SolarHistoryStore {
        SolarHistoryStore(directory: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
    }

    @Test("A fill's days join the history without marking it synced")
    func mergeKeepsDays() async throws {
        let history = store()
        try await history.merge(fill([day("2026-01-01", solarWh: 4)]), scope: scope)
        let samples = try await history.samples(scope: scope)
        #expect(samples.count == 288)
        #expect(samples.first?.solarWh == 4)
        #expect(try await history.timeZone(scope: scope)?.secondsFromGMT() == 0)
        #expect(try await history.isSynced(scope: scope, within: 86_400, now: now) == false)

        try await history.merge(fill([day("2026-01-01", solarWh: 6)]), scope: scope)
        #expect(try await history.samples(scope: scope).first?.solarWh == 6)
        try await history.removeAll()
    }

    @Test("Days merged while a sync is in flight survive that sync's save")
    func mergeDuringSync() async throws {
        let history = store()
        try await history.merge(fill([day("2026-01-01", solarWh: 1)]), scope: scope)
        let api = SuspendedHistoryAPI()
        let scope = scope
        let now = now
        let sync = Task { try await history.sync(scope: scope, api: api, now: now) }
        await api.waitUntilRequested()
        try await history.merge(fill([day("2026-01-02", solarWh: 2)]), scope: scope)
        await api.resume(with: .enabled(timeZone: .gmt, days: [day("2026-01-03", solarWh: 3)], nextFrom: nil))
        _ = try await sync.value
        let values = Set(try await history.samples(scope: scope).map(\.solarWh))
        #expect(values == [1, 2, 3])
        try await history.removeAll()
    }
}
