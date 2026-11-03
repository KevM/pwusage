import Foundation
@testable import PWUsage
import Testing

@Suite("Site history day ledger")
struct SiteHistoryDayLedgerTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
    private let other = SolarForecastSiteScope(accountScopeID: "account", siteID: "other")
    private let checkpoint = SiteHistoryCheckpoint(
        ranAt: Date(timeIntervalSince1970: 1_000), producingDays: 3, clearDays: 1, azimuthRange90: [170, 200])

    private static func folder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }

    @Test func packsOneCharacterPerDayFromTheOldest() {
        let ledger = SiteHistoryDayLedger(days: [
            "2026-10-30": .cloudy, "2026-11-01": .clear, "2026-10-29": .noProduction])
        #expect(ledger.firstDay == "2026-10-29")
        #expect(ledger.types == "no-c")
        #expect(ledger.dayTypes == ["2026-10-30": .cloudy, "2026-11-01": .clear, "2026-10-29": .noProduction])
        #expect(ledger.clearDays == 1)
        #expect(ledger.producingDays == 2)
    }

    @Test func aYearFitsInAFewKilobytes() throws {
        var days: [String: SolarDayType] = [:]
        for offset in 0 ..< 366 {
            let day = try #require(SiteLocalDays.adding(-offset, to: "2026-11-01", timeZone: .gmt))
            days[day] = [.clear, .cloudy, .noProduction][offset % 3]
        }
        var ledger = SiteHistoryDayLedger(days: days)
        ledger.checkpoint = checkpoint
        let encoded = try JSONEncoder().encode(ledger)
        #expect(encoded.count < 2_000)
        #expect(try JSONDecoder().decode(SiteHistoryDayLedger.self, from: encoded) == ledger)
    }

    @Test func savesPerAccountAndSiteAndReloads() async throws {
        let folder = Self.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = SiteHistoryDayLedgerStore(directory: folder)
        var ledger = SiteHistoryDayLedger(days: ["2026-11-01": .clear])
        ledger.checkpoint = checkpoint
        try await store.save(ledger, scope: scope)

        let reloaded = SiteHistoryDayLedgerStore(directory: folder)
        #expect(try await reloaded.ledger(scope: scope) == ledger)
        #expect(try await reloaded.ledger(scope: other) == nil)
        #expect(try await reloaded.ledger(
            scope: SolarForecastSiteScope(accountScopeID: "another", siteID: "site")) == nil)
    }

    @Test func removingOneSiteKeepsTheOthers() async throws {
        let folder = Self.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = SiteHistoryDayLedgerStore(directory: folder)
        try await store.save(SiteHistoryDayLedger(days: ["2026-11-01": .clear]), scope: scope)
        try await store.save(SiteHistoryDayLedger(days: ["2026-11-01": .cloudy]), scope: other)

        try await store.remove(scope: scope)

        #expect(try await store.ledger(scope: scope) == nil)
        #expect(try await store.ledger(scope: other) != nil)
    }

    @Test func isExcludedFromBackup() async throws {
        let folder = Self.folder()
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = SiteHistoryDayLedgerStore(directory: folder)
        try await store.save(SiteHistoryDayLedger(days: ["2026-11-01": .clear]), scope: scope)
        let values = try folder.resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(values.isExcludedFromBackup == true)
    }
}
