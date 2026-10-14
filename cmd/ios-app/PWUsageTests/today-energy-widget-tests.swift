import Foundation
import Testing
import SwiftUI
import WidgetKit
@testable import PWUsage

@Suite("Today's Energy Widget")
struct TodayEnergyWidgetTests {
    let now = Date(timeIntervalSince1970: 1_792_008_000)
    func snapshot() -> TodayEnergySnapshot {
        TodayEnergySnapshot(siteID: "home", siteName: "Home", timezone: "America/Chicago", fetchedAt: now,
            energy: TodayEnergy(localDate: TodayEnergySnapshot.localDate(now, timezone: "America/Chicago"), homeKwh: 12, solarKwh: 18, gridNetKwh: -4, batteryNetKwh: -2, energyDataThrough: now))
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
        let cache = DashboardCache(fileURL: directory.appendingPathComponent("app.json"), widgetStore: store)
        cache.storeSites([MobileSite(id: "home", name: "Home", utility: "Utility")])
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let key = CodingUserInfoKey.pwusageCurrentDate { decoder.userInfo[key] = now }
        let json = """
        {"version":1,"site":{"id":"home","name":"Home","timezone":"America/Chicago","localDate":"2026-10-14"},
         "live":{"solarPower":1000,"loadPower":2000,"batteryPower":500,"gridPower":500},
         "today":{"homeKwh":12,"solarKwh":18,"gridNetKwh":-6,"batteryNetKwh":-2},"todayComplete":true,
         "activeTariff":"Off peak","stateOfCharge":78,
         "sources":{"liveStatusAt":"2026-10-14T19:55:00Z","energyDataThrough":"2026-10-14T19:55:00Z","stateOfChargeAt":"2026-10-14T19:55:00Z"}}
        """
        let live = try decoder.decode(MobileLiveResponse.self, from: Data(json.utf8))
        cache.storeLive(live, at: now)
        #expect(store.load() == nil)
        cache.selectWidgetSite("home")
        #expect(store.load()?.siteID == "home")
        #expect(store.load()?.energy.homeKwh == 12)
        #expect(store.load()?.energy.solarKwh == 18)
        #expect(store.load()?.energy.gridNetKwh == -6)
        #expect(store.load()?.energy.batteryNetKwh == -2)
        #expect(store.load()?.stateOfCharge(at: now) == 78)
        cache.selectWidgetSite("other")
        #expect(store.load() == nil)
        cache.selectWidgetSite("home")
        #expect(store.load() != nil)
        cache.storeSites([])
        #expect(store.load() == nil)
        cache.storeLive(live, at: now)
        #expect(store.load() == nil)
        cache.clear()
        #expect(store.load() == nil)
    }

    @Test func daylightSavingMidnightUsesSiteTimezone() throws {
        let start = try #require(ISO8601DateFormatter().date(from: "2026-11-01T05:00:00Z"))
        let source = start.addingTimeInterval(24 * 3600)
        let value = TodayEnergySnapshot(siteID: "home", siteName: "Home", timezone: "America/Chicago", fetchedAt: start,
            energy: TodayEnergy(localDate: "2026-11-01", homeKwh: 1, solarKwh: 0, gridNetKwh: 1, batteryNetKwh: 0, energyDataThrough: source))
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
        #expect(tiles[2].value == DashboardPresentation.signedGridEnergy(-6))
        #expect(tiles[2].detail == "Net export")
        #expect(tiles[3].value == DashboardPresentation.signedBatteryEnergy(-2))
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
        let appTiles = TodayEnergyPresentation.tiles(homeKwh: 12, solarKwh: 18, gridNetKwh: -6, batteryNetKwh: -2,
                                                     stateOfCharge: 78)
        #expect(appTiles[3].symbolPrefix == nil)
        let expired = TodayEnergyPreviewFixtures.snapshot(chargeAge: 2 * 3600 + 1)
        #expect(TodayEnergyPresentation.tile(for: .battery, snapshot: expired, at: TodayEnergyPreviewFixtures.date)?.symbolPrefix == nil)

    }

    @MainActor
    @Test func renderActualWidgetContentForVisualInspection() throws {
        let fixtures: [(String, TodayEnergySnapshot?)] = [
            ("current", TodayEnergyPreviewFixtures.snapshot()),
            ("stale", TodayEnergyPreviewFixtures.snapshot(sourceAge: 2 * 3600)),
            ("unknown-charge", TodayEnergyPreviewFixtures.snapshot(stateOfCharge: nil)),
            ("partial", TodayEnergyPreviewFixtures.snapshot(complete: false)),
            ("long-name", TodayEnergyPreviewFixtures.snapshot(homeKwh: 1234.5, solarKwh: 456.7, gridNetKwh: 987.6,
                batteryNetKwh: -209.8, siteName: "Our family's home with a long site name")),
            ("missing", nil)
        ]
        let smallView = TodayEnergyWidgetContent(snapshot: TodayEnergyPreviewFixtures.snapshot(),
                                               date: TodayEnergyPreviewFixtures.date, compact: true)
            .padding(10).frame(width: 292, height: 141)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .environment(\.colorScheme, .light)
        let smallRenderer = ImageRenderer(content: smallView)
        smallRenderer.scale = 2
        let smallPNG = try #require(smallRenderer.uiImage?.pngData())
        let smallOutput = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("today-widget-small-medium.png")
        try smallPNG.write(to: smallOutput)
        print("Today widget render: \(smallOutput.path)")
        let largerTextView = TodayEnergyWidgetContent(snapshot: TodayEnergyPreviewFixtures.snapshot(),
                                                      date: TodayEnergyPreviewFixtures.date, compact: true)
            .padding(10).frame(width: 338, height: 158)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .environment(\.colorScheme, .light).environment(\.dynamicTypeSize, .xxxLarge)
        let largerTextRenderer = ImageRenderer(content: largerTextView)
        largerTextRenderer.scale = 2
        let largerTextPNG = try #require(largerTextRenderer.uiImage?.pngData())
        let largerTextOutput = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("today-widget-medium-larger-text.png")
        try largerTextPNG.write(to: largerTextOutput)
        print("Today widget render: \(largerTextOutput.path)")
        for compact in [true, false] {
            for dark in [false, true] {
                for (name, snapshot) in fixtures {
                    let view = TodayEnergyWidgetContent(snapshot: snapshot, date: TodayEnergyPreviewFixtures.date, compact: compact)
                        .padding(compact ? 10 : 16)
                        .frame(width: 338, height: compact ? 158 : 354)
                        .background(Color(uiColor: .secondarySystemGroupedBackground))
                        .environment(\.colorScheme, dark ? .dark : .light)
                    let renderer = ImageRenderer(content: view)
                    renderer.scale = 2
                    let png = try #require(renderer.uiImage?.pngData())
                    let output = URL(fileURLWithPath: NSTemporaryDirectory())
                        .appendingPathComponent("today-widget-\(compact ? "medium" : "large")-\(dark ? "dark" : "light")-\(name).png")
                    try png.write(to: output)
                    print("Today widget render: \(output.path)")
                }
            }
        }
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
            let tile = try #require(TodayEnergyPresentation.tile(for: metric, snapshot: value, at: TodayEnergyPreviewFixtures.date))
            #expect(tile.title == titles[index])
            #expect(tile.value == values[index])
        }
        let battery = try #require(TodayEnergyPresentation.tile(for: .battery, snapshot: value, at: TodayEnergyPreviewFixtures.date))
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

    @MainActor
    @Test func renderSmallWidgetSelections() throws {
        let extras: [(String, TodayEnergyMetric, TodayEnergySnapshot?)] = [
            ("stale-grid", .grid, TodayEnergyPreviewFixtures.snapshot(sourceAge: 2 * 3600)),
            ("full-soc", .battery, TodayEnergyPreviewFixtures.snapshot(stateOfCharge: 100)),
            ("unknown-soc", .battery, TodayEnergyPreviewFixtures.snapshot(stateOfCharge: nil)),
            ("large-number", .grid, TodayEnergyPreviewFixtures.snapshot(gridNetKwh: 1234.5)),
            ("missing", .solar, nil)
        ]
        let cases = TodayEnergyMetric.allCases.map { ($0.rawValue, $0, Optional(TodayEnergyPreviewFixtures.snapshot())) } + extras
        for (name, metric, value) in cases {
            for dark in [false, true] {
                let view = TodayEnergySingleMetricContent(snapshot: value, date: TodayEnergyPreviewFixtures.date, metric: metric)
                    .padding(10).frame(width: 141, height: 141)
                    .background(Color(uiColor: .secondarySystemGroupedBackground))
                    .environment(\.colorScheme, dark ? .dark : .light)
                    .environment(\.dynamicTypeSize, .xxxLarge)
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                let png = try #require(renderer.uiImage?.pngData())
                let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("today-widget-small-\(name)-\(dark ? "dark" : "light").png")
                try png.write(to: output)
                print("Today widget render: \(output.path)")
            }
        }
    }

    @Test func canvasSmallFamilyUsesSingleMetricInsteadOfFourMetricLayout() {
        #expect(TodayEnergyWidgetLayout(family: .systemSmall) == .singleMetric(.home))
        #expect(TodayEnergyWidgetLayout(family: .systemSmall, metric: .battery) == .singleMetric(.battery))
        #expect(TodayEnergyWidgetLayout(family: .systemMedium) == .medium)
        #expect(TodayEnergyWidgetLayout(family: .systemLarge) == .large)
    }

    @MainActor
    @Test func renderActualFamilyRoutingForCanvasOverride() throws {
        for metric in [TodayEnergyMetric.home, .battery] {
            let view = TodayEnergyWidgetFamilyContent(snapshot: TodayEnergyPreviewFixtures.snapshot(),
                date: TodayEnergyPreviewFixtures.date, family: .systemSmall, metric: metric)
                .frame(width: 141, height: 141)
                .background(Color(uiColor: .secondarySystemGroupedBackground))
                .environment(\.colorScheme, .light)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let png = try #require(renderer.uiImage?.pngData())
            let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("today-widget-canvas-small-\(metric.rawValue).png")
            try png.write(to: output)
            print("Today widget render: \(output.path)")
        }
    }
}
