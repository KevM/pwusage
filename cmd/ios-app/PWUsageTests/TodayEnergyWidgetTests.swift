import Foundation
@testable import PWUsage
import SwiftUI
import Testing
import WidgetKit

@Suite("Today's Energy Widget")
struct TodayEnergyWidgetTests {
    let now = Date(timeIntervalSince1970: 1_792_008_000)
    func snapshot() -> TodayEnergySnapshot {
        TodayEnergySnapshot(siteID: "home", siteName: "Home", timezone: "America/Chicago", fetchedAt: now,
                            energy: TodayEnergy(
                                localDate: TodayEnergySnapshot.localDate(now, timezone: "America/Chicago"),
                                homeKwh: 12, solarKwh: 18, gridNetKwh: -4,
                                batteryNetKwh: -2, energyDataThrough: now))
    }
    @Test func widgetSessionHasBoundedTimeouts() {
        let session = TodayEnergyWidgetRefresh.makeSession()
        defer { session.invalidateAndCancel() }
        #expect(session.configuration.timeoutIntervalForRequest == 8)
        #expect(session.configuration.timeoutIntervalForResource == 12)
        #expect(session.configuration.urlCache == nil)
    }

    @Test func freshAppSnapshotAvoidsNetwork() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TodayEnergySnapshotStore(fileURL: directory.appendingPathComponent("widget.json"))
        try store.save(snapshot())
        let session = URLSession(configuration: .ephemeral)
        session.invalidateAndCancel()
        let refresh = TodayEnergyWidgetRefresh(origin: URL(string: "https://example.invalid")!,
                                               session: session, store: store)
        #expect(await refresh.load(at: now) == snapshot())
        #expect(!FileManager.default.fileExists(atPath: store.refreshFileURL.path))
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
    @Test func widgetTracksLiveTotalsSelectionAndRevokedAccess() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TodayEnergySnapshotStore(fileURL: directory.appendingPathComponent("widget.json"))
        let clock = WidgetTrackingClock(now: now)
        let cache = DashboardCache(fileURL: directory.appendingPathComponent("app.json"), widgetStore: store,
                                   now: { clock.now }, reloadTimelines: { clock.reloads.append($0) })
        cache.storeSites([MobileSite(id: "home", name: "Home", utility: "Utility")])
        let live = try liveFixture(at: now)
        try assertWidgetSelectionAndThrottling(cache: cache, store: store, live: live, clock: clock)
        assertWidgetClearsTimelines(cache: cache, store: store, clock: clock)
    }

    @Test func optionalCostSurvivesLegacySnapshotsAndRejectsInvalidAmounts() throws {
        let legacy = try JSONEncoder().encode(snapshot())
        #expect(try JSONDecoder().decode(TodayEnergySnapshot.self, from: legacy).todayCost == nil)
        var cost = TodayEnergyCost(netCost: -2.5, importCharges: 0, exportCredits: 2.5, currency: "EUR")
        #expect(cost.isValid)
        cost.netCost = 2.5
        #expect(!cost.isValid)
        cost.netCost = -.infinity
        #expect(!cost.isValid)
    }

    @Test func todayCostDetailShowsExportCreditsAsPositive() {
        let cost = TodayEnergyCost(netCost: 2.47, importCharges: 3.12, exportCredits: 0.65, currency: "USD")
        #expect(TodayEnergyPresentation.todayCostDetail(cost, locale: Locale(identifier: "en_US"))
            == "Import $3.12 · Export $0.65")
    }

    @Test func daylightSavingMidnightUsesSiteTimezone() throws {
        let start = try #require(ISO8601DateFormatter().date(from: "2026-11-01T05:00:00Z"))
        let source = start.addingTimeInterval(24 * 3600)
        let value = TodayEnergySnapshot(siteID: "home", siteName: "Home", timezone: "America/Chicago", fetchedAt: start,
                                        energy: TodayEnergy(localDate: "2026-11-01", homeKwh: 1, solarKwh: 0,
                                                            gridNetKwh: 1, batteryNetKwh: 0, energyDataThrough: source))
        #expect(value.nextMidnight == start.addingTimeInterval(25 * 3600))
        #expect(value.availability(at: source) == .current)
        #expect(value.availability(at: start.addingTimeInterval(25 * 3600)) == .missing)
    }

    @Test func batteryChargeUsesItsOwnSourceAndExpiresIndependently() {
        var value = snapshot()
        value.batteryStateOfCharge = 78
        value.batteryStateOfChargeAt = now.addingTimeInterval(-2 * 3600)
        #expect(value.stateOfCharge(at: now) == 78)
        #expect(value.stateOfCharge(at: now.addingTimeInterval(1)) == nil)
        #expect(value.availability(at: now.addingTimeInterval(1)) == .current)
        value.batteryStateOfChargeAt = now.addingTimeInterval(1)
        #expect(value.stateOfCharge(at: now) == nil)
        value.batteryStateOfChargeAt = nil
        #expect(value.stateOfCharge(at: now) == nil)
        value.batteryStateOfChargeAt = now
        value.batteryStateOfCharge = 101
        #expect(value.stateOfCharge(at: now) == nil)
    }

    @MainActor
    @Test func appAndWidgetShareEnergyGlyphsAndDirectionLabels() {
        let tiles = TodayEnergyPresentation.tiles(homeKwh: 12, solarKwh: 18, gridNetKwh: -6, batteryNetKwh: -2,
                                                  compact: true, showsStateOfCharge: true, stateOfCharge: 78)
        #expect(tiles.map(\.title) == ["Home", "Solar", "Grid", "Battery"])
        #expect(tiles.map(\.symbol) == ["house.fill", "sun.max.fill", "powerplug", "battery.75percent"])
        #expect(tiles[2].value == TodayEnergyPresentation.signedEnergy(-6))
        #expect(tiles[2].detail == "Net export")
        #expect(tiles[3].value == TodayEnergyPresentation.signedEnergy(-2))
        #expect(tiles[3].detail == "Net charge")
        #expect(tiles[3].spokenRole == "Battery charge 78 percent")
        #expect(tiles[3].symbolPrefix == "78%")
        let unknown = TodayEnergyPresentation.tiles(homeKwh: 12, solarKwh: 18, gridNetKwh: 6, batteryNetKwh: 2,
                                                    showsStateOfCharge: true)
        #expect(unknown[2].detail == "Net import")
        #expect(unknown[3].detail == "Net discharge")
        #expect(unknown[3].symbol == "battery.0percent")
        #expect(unknown[3].spokenRole == "Battery charge unknown")
        #expect(unknown[3].symbolPrefix == nil)
        let even = TodayEnergyPresentation.tiles(homeKwh: 12, solarKwh: 18, gridNetKwh: 0, batteryNetKwh: 0)
        #expect(even[2].detail == "Even")
        #expect(even[3].detail == "Even")
        let appTiles = TodayEnergyPresentation.tiles(homeKwh: 12, solarKwh: 18, gridNetKwh: -6, batteryNetKwh: -2,
                                                     stateOfCharge: 78)
        #expect(appTiles[3].symbolPrefix == nil)
        let expired = TodayEnergyPreviewFixtures.snapshot(chargeAge: 2 * 3600 + 1)
        #expect(TodayEnergyPresentation.tile(for: .battery, snapshot: expired, at: TodayEnergyPreviewFixtures.date)?
            .symbolPrefix == nil)
    }

    @Test func batteryGlyphChargeBandsMatchApp() {
        for charge in [0.0, 12, 13, 37, 38, 62, 63, 87, 88, 100] {
            #expect(TodayEnergyPresentation.batterySymbol(charge)
                == DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: charge))
        }
        #expect(TodayEnergyPresentation.batterySymbol(nil) == "battery.0percent")
    }

    @MainActor
    @Test func smallWidgetUsesTheSelectedMetric() throws {
        let value = TodayEnergyPreviewFixtures.snapshot()
        let titles = ["Home", "Solar", "Grid", "Battery"]
        let values = ["18.4 kWh", "22.6 kWh", "↑ 2.4 kWh", "↑ 1.8 kWh"]
        for (index, metric) in TodayEnergyMetric.allCases.enumerated() {
            let tile = try #require(
                TodayEnergyPresentation.tile(for: metric, snapshot: value, at: TodayEnergyPreviewFixtures.date)
            )
            #expect(tile.title == titles[index])
            #expect(tile.value == values[index])
        }
        let battery = try #require(
            TodayEnergyPresentation.tile(for: .battery, snapshot: value, at: TodayEnergyPreviewFixtures.date)
        )
        #expect(battery.symbol == "battery.75percent")
        #expect(battery.spokenRole == "Battery charge 78 percent")
    }

    @MainActor
    @Test func smallWidgetNeverShowsPriorDayOrMissingEnergy() {
        let value = TodayEnergyPreviewFixtures.snapshot()
        for metric in TodayEnergyMetric.allCases {
            #expect(TodayEnergyPresentation.tile(for: metric, snapshot: nil, at: now) == nil)
            #expect(TodayEnergyPresentation.tile(for: metric, snapshot: value,
                                                 at: TodayEnergyPreviewFixtures.date.addingTimeInterval(86400)) == nil)
        }
    }

    @Test func bothWidgetKindsUseSourceExpiryTimelineDates() throws {
        let value = TodayEnergyPreviewFixtures.snapshot()
        let dates = TodayEnergySnapshot.timelineDates(for: value, at: TodayEnergyPreviewFixtures.date)
        #expect(dates.first == TodayEnergyPreviewFixtures.date)
        let energySource = try #require(value.energy.energyDataThrough)
        let chargeSource = try #require(value.batteryStateOfChargeAt)
        let midnight = try #require(value.nextMidnight)
        #expect(dates.contains(energySource.addingTimeInterval(TodayEnergySnapshot.staleAfter + 1)))
        #expect(dates.contains(chargeSource.addingTimeInterval(2 * 3600 + 1)))
        #expect(dates.contains(midnight))
        #expect(TodayEnergySnapshot.timelineDates(for: nil, at: now) == [now])
    }

    @Test func canvasSmallFamilyUsesSingleMetricInsteadOfFourMetricLayout() {
        #expect(TodayEnergyWidgetLayout(family: .systemSmall) == .singleMetric(.home))
        #expect(TodayEnergyWidgetLayout(family: .systemSmall, metric: .battery) == .singleMetric(.battery))
        #expect(TodayEnergyWidgetLayout(family: .systemMedium) == .medium)
        #expect(TodayEnergyWidgetLayout(family: .systemLarge) == .large)
    }

    @MainActor
    @Test func emptyAuthorizationClearsOrphanedWidgetAfterPrivateCacheEviction() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = TodayEnergySnapshotStore(fileURL: directory.appendingPathComponent("widget.json"))
        let previousReading = TodayEnergyPreviewFixtures.snapshot()
        try store.save(previousReading)
        #expect(previousReading.availability(at: TodayEnergyPreviewFixtures.date) == .current)

        // The App Group file survives, but the app-private cache is missing at cold launch.
        let missingPrivateCache = directory.appendingPathComponent("evicted-dashboard.json")
        #expect(!FileManager.default.fileExists(atPath: missingPrivateCache.path))
        let cache = DashboardCache(fileURL: missingPrivateCache, widgetStore: store)
        #expect(cache.snapshot.sites.isEmpty)
        #expect(store.load() != nil)
        cache.storeSites([])
        #expect(store.load() == nil)
        #expect(TodayEnergySnapshotStore(fileURL: store.fileURL).load() == nil)
    }

    /// Decodes the live payload the widget cache stores for the tracking test.
    private func liveFixture(at now: Date) throws -> MobileLiveResponse {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let key = CodingUserInfoKey.pwusageCurrentDate { decoder.userInfo[key] = now }
        let json = """
        {"version":1,"site":{"id":"home","name":"Home","timezone":"America/Chicago","localDate":"2026-10-14"},
         "live":{"solarPower":1000,"loadPower":2000,"batteryPower":500,"gridPower":500},
         "today":{"homeKwh":12,"solarKwh":18,"gridNetKwh":-6,"batteryNetKwh":-2},"todayComplete":true,
         "activeTariff":"Off peak","stateOfCharge":78,
         "todayCost":{"netCost":2.47,"importCharges":3.12,"exportCredits":0.65,"currency":"EUR"},
         "sources":{"liveStatusAt":"2026-10-14T19:55:00Z","energyDataThrough":"2026-10-14T19:55:00Z",
         "stateOfChargeAt":"2026-10-14T19:55:00Z"}}
        """
        return try decoder.decode(MobileLiveResponse.self, from: Data(json.utf8))
    }

    /// Writes readings and follows the widget selection through throttling, cost encoding and revocation.
    @MainActor
    private func assertWidgetSelectionAndThrottling(
        cache: DashboardCache, store: TodayEnergySnapshotStore, live: MobileLiveResponse, clock: WidgetTrackingClock
    ) throws {
        cache.storeLive(live, at: clock.now)
        #expect(store.load() == nil)
        cache.selectWidgetSite("home")
        #expect(clock.reloads == [TodayEnergySnapshot.widgetKind, TodayEnergySnapshot.metricWidgetKind])
        cache.storeLive(live, at: clock.now)
        #expect(clock.reloads.count == 2, "An equal snapshot must not reload either kind.")
        clock.now = now.addingTimeInterval(899)
        cache.storeLive(live, at: clock.now)
        #expect(store.load()?.fetchedAt == clock.now, "Throttling reloads must not throttle writes.")
        #expect(clock.reloads.count == 2)
        clock.now = now.addingTimeInterval(900)
        cache.storeLive(live, at: clock.now)
        #expect(clock.reloads.count == 4, "Changed snapshots may reload at the fifteen-minute floor.")
        #expect(store.load()?.siteID == "home")
        #expect(store.load()?.energy.homeKwh == 12)
        #expect(store.load()?.energy.solarKwh == 18)
        #expect(store.load()?.energy.gridNetKwh == -6)
        #expect(store.load()?.energy.batteryNetKwh == -2)
        #expect(store.load()?.stateOfCharge(at: now) == 78)
        let encoded = try JSONEncoder().encode(#require(store.load()))
        let payload = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let cost = try #require(payload["todayCost"] as? [String: Any])
        #expect(cost["netCost"] as? Double == 2.47)
        #expect(cost["currency"] as? String == "EUR")
        clock.now = now.addingTimeInterval(901)
        cache.selectWidgetSite("other")
        #expect(store.load() == nil)
        #expect(clock.reloads.count == 6, "Removing a selection bypasses the reload floor.")
        cache.selectWidgetSite("home")
        #expect(store.load() != nil)
        #expect(clock.reloads.count == 8, "The first replacement reloads immediately.")
        cache.storeSites([])
        #expect(store.load() == nil)
        #expect(clock.reloads.count == 10, "Revocation immediately invalidates both timelines.")
        cache.storeLive(live, at: clock.now)
        #expect(store.load() == nil)
        cache.storeSites([MobileSite(id: "home", name: "Home", utility: "Utility")])
        cache.storeLive(live, at: clock.now)
        cache.selectWidgetSite("home")
        #expect(store.load() != nil)
        #expect(clock.reloads.count == 12, "Restored access reloads the replacement immediately.")
        clock.now = clock.now.addingTimeInterval(1)
        cache.storeLive(live, at: clock.now)
        #expect(clock.reloads.count == 12, "Later routine updates remain throttled.")
    }

    @MainActor
    private func assertWidgetClearsTimelines(cache: DashboardCache, store: TodayEnergySnapshotStore,
                                             clock: WidgetTrackingClock) {
        cache.clear()
        #expect(store.load() == nil)
        #expect(clock.reloads.count == 14, "Logout or session expiry immediately invalidates both timelines.")
        cache.clear()
        #expect(clock.reloads.count == 14, "An already empty store needs no further reload.")
    }
}

/// A mutable clock and reload log shared by the widget-tracking test and its helpers.
private final class WidgetTrackingClock {
    var now: Date
    var reloads: [String] = []

    init(now: Date) {
        self.now = now
    }
}
