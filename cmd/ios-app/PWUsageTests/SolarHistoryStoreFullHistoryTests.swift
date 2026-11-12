import CryptoKit
import Foundation
@testable import PWUsage
import Testing

@Suite("Solar History Store full history")
struct SolarHistoryStoreFullHistoryTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
    private let utc = TimeZone(identifier: "UTC") ?? .gmt
    /// 2026-11-11 12:00 UTC.
    private let now = Date(timeIntervalSince1970: 1_794_398_400)

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        return calendar
    }

    private func day(_ daysBeforeNow: Int, value: Double = 10) -> MobileSolarHistoryDay {
        let today = calendar.startOfDay(for: now)
        let start = calendar.date(byAdding: .day, value: -daysBeforeNow, to: today) ?? today
        return MobileSolarHistoryDay(
            day: "d\(daysBeforeNow)", dayStart: start, status: .complete, fetchedAt: nil,
            solarWh: (0 ..< 288).map { $0 % 3 == 0 ? nil : value + Double($0 % 7) })
    }

    private func fill(_ days: [MobileSolarHistoryDay]) -> MobileSolarHistoryFill {
        MobileSolarHistoryFill(timeZone: utc, status: .complete, historyStart: "2016-01-01", days: days)
    }

    private func temporaryFolder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("full-history-\(UUID().uuidString)")
    }

    private func yearFiles(in folder: URL) -> [URL] {
        let enumerator = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: nil)
        return (enumerator?.allObjects as? [URL] ?? [])
            .filter { $0.deletingLastPathComponent().lastPathComponent.hasSuffix("-days") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    // MARK: - Keeping every day

    @Test("A sync keeps days older than 400 days and detection reads only the recent window")
    func syncKeepsOldDays() async throws {
        let store = SolarHistoryStore(directory: temporaryFolder())
        try await store.merge(fill([day(1000), day(500), day(10)]), scope: scope)
        let api = HistoryAPI(responses: [.enabled(timeZone: utc, days: [], nextFrom: nil)])
        _ = try await store.sync(scope: scope, api: api, now: now)

        #expect(try await store.allStoredDays(scope: scope).count == 3)
        #expect(try await store.allSamples(scope: scope).count == 3 * 192)
        // The windowed reads are what detection and the strip have always seen.
        #expect(try await store.samples(scope: scope, now: now).count == 192)
        #expect(try await store.storedDays(scope: scope, now: now).count == 1)
    }

    @Test("A day just inside the 400-day window is read and one just outside is not")
    func windowEdge() async throws {
        let store = SolarHistoryStore(directory: temporaryFolder())
        try await store.merge(fill([day(400), day(401)]), scope: scope)
        #expect(try await store.storedDays(scope: scope, now: now).count == 1)
        #expect(try await store.allStoredDays(scope: scope).count == 2)
    }

    // MARK: - Per-year files

    @Test("Days are saved as one file per year and reload identically")
    func savesPerYear() async throws {
        let folder = temporaryFolder()
        let store = SolarHistoryStore(directory: folder)
        try await store.merge(fill([day(2000), day(1900), day(10)]), scope: scope)
        #expect(yearFiles(in: folder).count == 3) // 2021, 2021 or 2022 split by year, plus 2026
        let reloaded = SolarHistoryStore(directory: folder)
        let before = try await store.allSamples(scope: scope).map(\.solarWh)
        let after = try await reloaded.allSamples(scope: scope).map(\.solarWh)
        #expect(before == after)
        try await store.removeAll()
    }

    @Test("Saving a recent day does not rewrite the files of earlier years")
    func savingTouchesOnlyChangedYears() async throws {
        let folder = temporaryFolder()
        let store = SolarHistoryStore(directory: folder)
        try await store.merge(fill([day(2000), day(10)]), scope: scope)
        let oldFile = try #require(yearFiles(in: folder).first)
        let before = try FileManager.default.attributesOfItem(atPath: oldFile.path)[.modificationDate] as? Date
        try await store.merge(fill([day(9)]), scope: scope)
        let after = try FileManager.default.attributesOfItem(atPath: oldFile.path)[.modificationDate] as? Date
        #expect(before != nil)
        #expect(before == after)
        try await store.removeAll()
    }

    @Test("Removing a site deletes its year files")
    func removeDeletesYearFiles() async throws {
        let folder = temporaryFolder()
        let store = SolarHistoryStore(directory: folder)
        try await store.merge(fill([day(2000), day(10)]), scope: scope)
        #expect(!yearFiles(in: folder).isEmpty)
        try await store.remove(scope: scope)
        #expect(yearFiles(in: folder).isEmpty)
        #expect(try await store.allSamples(scope: scope).isEmpty)
        try await store.removeAll()
    }

    @Test("A disabled sync clears the days and their files")
    func disabledClearsFiles() async throws {
        let folder = temporaryFolder()
        let store = SolarHistoryStore(directory: folder)
        try await store.merge(fill([day(2000), day(10)]), scope: scope)
        _ = try await store.sync(scope: scope, api: HistoryAPI(responses: [.disabled]), now: now)
        #expect(yearFiles(in: folder).isEmpty)
        #expect(try await store.allSamples(scope: scope).isEmpty)
        try await store.removeAll()
    }

    // MARK: - Older stores

    @Test("A store written before per-year files loads, then migrates on its next save")
    func legacyFileMigrates() async throws {
        let folder = temporaryFolder()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let hash = SHA256.hash(data: Data("account|site".utf8)).map { String(format: "%02x", $0) }.joined()
        let start = calendar.startOfDay(for: now).timeIntervalSinceReferenceDate
        let legacy = """
        {"timeZone":"UTC","isEnabled":true,"days":[{"dayStart":\(start),"slots":[1.5,null,2.0]}]}
        """
        try Data(legacy.utf8).write(to: folder.appendingPathComponent("\(hash).json"))

        let store = SolarHistoryStore(directory: folder)
        #expect(try await store.allSamples(scope: scope).map(\.solarWh) == [1.5, 2.0])
        try await store.merge(fill([day(5)]), scope: scope)
        #expect(!yearFiles(in: folder).isEmpty)
        let reloaded = SolarHistoryStore(directory: folder)
        #expect(try await reloaded.allSamples(scope: scope).count == 2 + 192)
        try await store.removeAll()
    }

    // MARK: - Size

    @Test("A ten-year store loads within a time budget")
    func tenYearStoreLoadsQuickly() async throws {
        let folder = temporaryFolder()
        let store = SolarHistoryStore(directory: folder)
        for chunk in 0 ..< 10 {
            try await store.merge(fill((0 ..< 365).map { day(chunk * 365 + $0) }), scope: scope)
        }
        let reloaded = SolarHistoryStore(directory: folder)
        let started = ContinuousClock.now
        let count = try await reloaded.allStoredDays(scope: scope).count
        let elapsed = started.duration(to: .now)
        #expect(count == 3650)
        #expect(elapsed < .seconds(3))
        try await store.removeAll()
    }
}
