import Foundation
import Testing
@testable import PWUsage

@Suite("Today's Energy Widget")
struct TodayEnergyWidgetTests {
    let now = Date(timeIntervalSince1970: 1_792_008_000)
    func snapshot() -> TodayEnergySnapshot {
        TodayEnergySnapshot(siteID: "home", siteName: "Home", timezone: "America/Chicago", fetchedAt: now,
            energy: TodayEnergy(localDate: TodayEnergySnapshot.localDate(now, timezone: "America/Chicago"), homeKwh: 12, importKwh: 4, exportKwh: 2, estimatedCost: -0.5, currency: "USD", energyDataThrough: now))
    }
    @Test func sourceAgeAndSiteMidnightControlAvailability() {
        let value = snapshot()
        #expect(value.availability(at: now) == .current)
        #expect(value.availability(at: now.addingTimeInterval(3601)) == .stale)
        #expect(value.availability(at: now.addingTimeInterval(86400)) == .missing)
        #expect(value.availability(at: now.addingTimeInterval(-1)) == .missing)
    }
    @Test func missingSourcesAndInvalidNumbersAreUnknown() {
        var value = snapshot()
        value.energy.energyDataThrough = nil
        #expect(value.availability(at: now) == .missing)
        value = snapshot()
        value.energy.homeKwh = -.infinity
        #expect(value.availability(at: now) == .missing)
    }
    @Test func atomicCacheRoundTripCorruptionAndClear() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TodayEnergySnapshotStore(fileURL: directory.appendingPathComponent("widget.json"))
        try store.save(snapshot())
        #expect(store.load() == snapshot())
        try Data("invalid".utf8).write(to: store.fileURL)
        #expect(store.load() == nil)
        try store.save(snapshot())
        store.clear()
        #expect(store.load() == nil)
    }

    @MainActor
    @Test func widgetTracksSelectionAndClearsRevokedAccess() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TodayEnergySnapshotStore(fileURL: directory.appendingPathComponent("widget.json"))
        let cache = DashboardCache(fileURL: directory.appendingPathComponent("app.json"), widgetStore: store)
        cache.storeSites([MobileSite(id: "home", name: "Home", utility: "Utility")])
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let json = """
        {"version":1,"site":{"id":"home","name":"Home","timezone":"America/Chicago"},
         "currentBill":{"estimatedCost":100,"currency":"USD","cycleStart":"2026-10-01T00:00:00Z","cycleEnd":"2026-11-01T00:00:00Z","periods":[]},
         "todayEnergy":{"localDate":"2026-10-14","homeKwh":12,"importKwh":4,"exportKwh":2,"estimatedCost":-0.5,"currency":"USD","energyDataThrough":"2026-10-14T12:00:00Z"},
         "sources":{"calculatedAt":"2026-10-14T12:00:00Z","energyDataThrough":"2026-10-14T12:00:00Z"}}
        """
        let bill = try decoder.decode(MobileBillResponse.self, from: Data(json.utf8))
        cache.storeBill(bill, at: now)
        #expect(store.load() == nil) // no selected verified site yet
        cache.selectWidgetSite("home")
        #expect(store.load()?.energy.estimatedCost == -0.5) // never the cycle's $100
        cache.selectWidgetSite("other")
        #expect(store.load() == nil)
        cache.selectWidgetSite("home")
        #expect(store.load() != nil)
        cache.storeSites([])
        #expect(store.load() == nil)
        cache.storeBill(bill, at: now)
        #expect(store.load() == nil) // late or unauthorized writes cannot repopulate
        cache.clear()
        #expect(store.load() == nil)
    }

    @Test func daylightSavingMidnightUsesSiteTimezone() throws {
        let start = try #require(ISO8601DateFormatter().date(from: "2026-11-01T05:00:00Z"))
        let source = start.addingTimeInterval(24 * 3600)
        let value = TodayEnergySnapshot(siteID: "home", siteName: "Home", timezone: "America/Chicago", fetchedAt: start,
            energy: TodayEnergy(localDate: "2026-11-01", homeKwh: 1, importKwh: 1, exportKwh: 0, estimatedCost: nil,
                                currency: "USD", energyDataThrough: source))
        #expect(value.nextMidnight == start.addingTimeInterval(25 * 3600))
        #expect(value.availability(at: source) == .current)
        #expect(value.availability(at: start.addingTimeInterval(25 * 3600)) == .missing)
    }
}
