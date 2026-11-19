import Foundation
@testable import PWUsage
import Testing

@Suite("Solar History Store flow watermark")
struct SolarHistoryStoreFlowWatermarkTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
    private let utc = TimeZone(identifier: "UTC") ?? .gmt

    @Test("A later flow sync asks only for days changed since the last complete cycle read")
    func laterSyncUsesWatermark() async throws {
        let history = SolarHistoryStore(directory: temporaryFolder())
        defer { Task { try? await history.removeAll() } }
        let now = try date("2026-10-24T12:00:00Z")
        let fetchedAt = try date("2026-10-24T11:00:00Z")
        let first = HistoryAPI(responses: [
            .enabled(timeZone: utc, days: [try flowDay("2026-10-01", fetchedAt: fetchedAt)], nextFrom: nil)
        ])
        _ = try await history.syncFlows(scope: scope, api: first, cycleStartDay: "2026-10-01", now: now)

        let second = HistoryAPI(responses: [.enabled(timeZone: utc, days: [], nextFrom: nil)])
        let progress = try await history.syncFlows(scope: scope, api: second, cycleStartDay: "2026-10-01", now: now)

        #expect(progress == .complete)
        #expect(await first.requests.map(\.changedSince) == [nil])
        let requests = await second.requests
        #expect(requests.map(\.from) == ["2026-10-01"])
        #expect(requests.map(\.changedSince) == [fetchedAt.addingTimeInterval(-300)])
    }

    @Test("The flow watermark survives a new store instance")
    func watermarkPersists() async throws {
        let folder = temporaryFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let now = try date("2026-10-24T12:00:00Z")
        let fetchedAt = try date("2026-10-24T11:00:00Z")
        let first = HistoryAPI(responses: [
            .enabled(timeZone: utc, days: [try flowDay("2026-10-01", fetchedAt: fetchedAt)], nextFrom: nil)
        ])
        _ = try await SolarHistoryStore(directory: folder)
            .syncFlows(scope: scope, api: first, cycleStartDay: "2026-10-01", now: now)

        let second = HistoryAPI(responses: [.enabled(timeZone: utc, days: [], nextFrom: nil)])
        _ = try await SolarHistoryStore(directory: folder)
            .syncFlows(scope: scope, api: second, cycleStartDay: "2026-10-01", now: now)

        #expect(await second.requests.map(\.changedSince) == [fetchedAt.addingTimeInterval(-300)])
    }

    @Test("A cycle that starts before the last full read reads the whole cycle again")
    func earlierCycleStartReadsFully() async throws {
        let history = SolarHistoryStore(directory: temporaryFolder())
        defer { Task { try? await history.removeAll() } }
        let now = try date("2026-10-24T12:00:00Z")
        let first = HistoryAPI(responses: [
            .enabled(timeZone: utc, days: [try flowDay("2026-10-10", fetchedAt: now)], nextFrom: nil)
        ])
        _ = try await history.syncFlows(scope: scope, api: first, cycleStartDay: "2026-10-10", now: now)

        let second = HistoryAPI(responses: [
            .enabled(timeZone: utc, days: [try flowDay("2026-10-01", fetchedAt: now)], nextFrom: nil)
        ])
        _ = try await history.syncFlows(scope: scope, api: second, cycleStartDay: "2026-10-01", now: now)

        let requests = await second.requests
        #expect(requests.map(\.from) == ["2026-10-01"])
        #expect(requests.map(\.changedSince) == [nil])
    }

    @Test("An interrupted cycle read leaves no watermark, so the next read is full")
    func interruptedReadKeepsFullFetch() async throws {
        let history = SolarHistoryStore(directory: temporaryFolder())
        defer { Task { try? await history.removeAll() } }
        let now = try date("2026-10-24T12:00:00Z")
        let interrupted = HistoryAPI(
            responses: [.enabled(timeZone: utc, days: [try flowDay("2026-10-01", fetchedAt: now)],
                                 nextFrom: "2026-10-02")],
            failAt: 2
        )
        await #expect(throws: HistoryFailure.injected) {
            try await history.syncFlows(scope: scope, api: interrupted, cycleStartDay: "2026-10-01", now: now)
        }

        let retry = HistoryAPI(responses: [.enabled(timeZone: utc, days: [], nextFrom: nil)])
        _ = try await history.syncFlows(scope: scope, api: retry, cycleStartDay: "2026-10-01", now: now)

        #expect(await retry.requests.map(\.changedSince) == [nil])
    }

    @Test("Each flow page rewrites only the year files it changed")
    func pagesRewriteOnlyChangedYears() async throws {
        let folder = temporaryFolder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let history = SolarHistoryStore(directory: folder)
        let yearFile = folder
            .appendingPathComponent("\(scope.storageHash)-days", isDirectory: true)
            .appendingPathComponent("2025.json")
        let now = try date("2026-01-15T12:00:00Z")
        // Remove the 2025 file once page one has saved it: a page that rewrites it would bring it back.
        let api = HistoryAPI(
            responses: [
                .enabled(timeZone: utc, days: [try flowDay("2025-12-01", fetchedAt: now)], nextFrom: "2026-01-01"),
                .enabled(timeZone: utc, days: [try flowDay("2026-01-01", fetchedAt: now)], nextFrom: nil)
            ],
            onRequest: { count in
                if count == 2 { try? FileManager.default.removeItem(at: yearFile) }
            }
        )

        _ = try await history.syncFlows(scope: scope, api: api, cycleStartDay: "2025-12-01", now: now)

        #expect(await api.requests.count == 2)
        #expect(!FileManager.default.fileExists(atPath: yearFile.path))
        #expect(FileManager.default.fileExists(
            atPath: yearFile.deletingLastPathComponent().appendingPathComponent("2026.json").path))
    }

    private func flowDay(_ day: String, fetchedAt: Date) throws -> MobileSolarHistoryDay {
        let start = try date("\(day)T00:00:00Z")
        return MobileSolarHistoryDay(
            day: day, dayStart: start, status: .complete, fetchedAt: fetchedAt,
            solarWh: Array(repeating: 1, count: 288),
            loadWh: Array(repeating: 2, count: 288),
            gridWh: Array(repeating: 3, count: 288),
            batteryWh: Array(repeating: 4, count: 288),
            batterySoc: Array(repeating: 50, count: 288)
        )
    }

    private func date(_ iso: String) throws -> Date {
        try #require(ISO8601DateFormatter().date(from: iso))
    }

    private func temporaryFolder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("flow-watermark-\(UUID().uuidString)")
    }
}
