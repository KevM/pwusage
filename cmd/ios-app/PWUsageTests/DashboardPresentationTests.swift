import Foundation
@testable import PWUsage
import Testing

@Suite("Dashboard Presentation Tests")
struct DashboardPresentationTests {
    @Test("Home stays quiet for ordinary summary lag and prompts only beyond an hour")
    func homeRefreshPromptThreshold() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(!DashboardPresentation.homeNeedsRefresh([], now: now))
        #expect(!DashboardPresentation.homeNeedsRefresh([now, now.addingTimeInterval(-1800)], now: now))
        #expect(!DashboardPresentation.homeNeedsRefresh([now.addingTimeInterval(-3600)], now: now))
        #expect(DashboardPresentation.homeNeedsRefresh([now, now.addingTimeInterval(-3601)], now: now))
        #expect(DashboardPresentation.homeNeedsRefresh([now, nil], now: now))
        #expect(DashboardPresentation.homeNeedsRefresh([now.addingTimeInterval(60)], now: now))
    }

    private let flowNow = Date(timeIntervalSince1970: 1_800_000_000)

    private func flow(solar: Double, home: Double, grid: Double, battery: Double,
                      age: TimeInterval = 0, unavailable: Bool = false) -> DashboardPresentation.PowerFlow {
        DashboardPresentation.powerFlow(
            solarPower: solar, loadPower: home, batteryPower: battery, gridPower: grid,
            sourceTime: flowNow.addingTimeInterval(-age), isUnavailable: unavailable, now: flowNow
        )
    }

    @Test("Screenshot flow keeps idle grid in the spare receiving slot")
    func screenshotPowerFlow() {
        let result = flow(solar: 754, home: 1064, grid: 0, battery: 310)
        #expect(result.supplying.map(\.id) == [.solar, .battery])
        #expect(result.receiving.map(\.id) == [.home, .grid])
        #expect(result.receiving.last?.role == .idle)
        #expect(result.receiving.last?.detail == "Idle")
    }

    @Test("Grid charging and night flow stay two by two with idle solar")
    func idleCardsFillSpareSlots() {
        let charging = flow(solar: 0, home: 1000, grid: 3000, battery: -2000)
        #expect(charging.supplying.map(\.id) == [.grid, .solar])
        #expect(charging.receiving.map(\.id) == [.home, .battery])
        #expect(charging.receiving.last?.detail == "Charging")
        let night = flow(solar: 0, home: 1000, grid: 0, battery: 1000)
        #expect(night.supplying.count == 2)
        #expect(night.receiving.count == 2)
        #expect(night.supplying.first?.id == .battery)
        #expect(night.supplying.first?.detail == "Discharging")
    }

    @Test("Export and charge are receivers, even when three active receivers need three rows")
    func exportAndChargeRoles() {
        let result = flow(solar: 4000, home: 1000, grid: -1000, battery: -2000)
        #expect(result.supplying.map(\.id) == [.solar])
        #expect(result.receiving.map(\.id) == [.home, .grid, .battery])
        #expect(result.receiving[1].detail == "Exporting")
        #expect(result.receiving.allSatisfy { $0.role == .receiving })
    }

    @Test("Every direction combination keeps each card exactly once")
    func allPowerCardsPersist() {
        for solar in [0.0, 1000.0] {
            for grid in [-1000.0, 0.0, 1000.0] {
                for battery in [-1000.0, 0.0, 1000.0] {
                    let result = flow(solar: solar, home: 1000, grid: grid, battery: battery)
                    let cards = result.supplying + result.receiving
                    #expect(cards.count == 4)
                    #expect(Set(cards.map(\.id)).count == 4)
                    #expect(cards.filter { $0.role == .supplying }.allSatisfy { result.supplying.contains($0) })
                    #expect(cards.filter { $0.role == .receiving }.allSatisfy { result.receiving.contains($0) })
                }
            }
        }
    }

    @Test("Grid and battery use the existing 50 watt deadband")
    func powerFlowDeadband() {
        for watts in [-50.0, 0.0, 50.0] {
            let cards = flow(solar: 0, home: 0, grid: watts, battery: watts)
            #expect((cards.supplying + cards.receiving).allSatisfy { $0.role == .idle })
        }
        let importing = flow(solar: 0, home: 100, grid: 51, battery: 51)
        #expect(importing.supplying.map(\.id).contains(.grid))
        #expect(importing.supplying.map(\.id).contains(.battery))
    }

    @Test("Stale, unavailable, missing and future source times never imply current flow or idle")
    func unknownPowerFlow() {
        for age in [901.0, -1.0] {
            let result = flow(solar: 1000, home: 1000, grid: 0, battery: 0, age: age)
            #expect((result.supplying + result.receiving).allSatisfy { $0.role == .unknown && $0.detail == "Flow unknown" })
        }
        let unavailable = flow(solar: 1000, home: 1000, grid: 0, battery: 0, unavailable: true)
        #expect((unavailable.supplying + unavailable.receiving).allSatisfy { $0.role == .unknown })
        let missing = DashboardPresentation.powerFlow(
            solarPower: 0, loadPower: 0, batteryPower: 0, gridPower: 0,
            sourceTime: nil, isUnavailable: false, now: flowNow
        )
        #expect((missing.supplying + missing.receiving).allSatisfy { $0.role == .unknown })
        let invalid = flow(solar: .nan, home: -.infinity, grid: 100, battery: 0)
        #expect((invalid.supplying + invalid.receiving).filter { $0.id == .solar || $0.id == .home }.allSatisfy { $0.role == .unknown && $0.watts == nil })
    }

    @Test("Unchanged readings expire locally before the next five-minute refresh")
    func powerFlowExpiresWithoutNewResponse() {
        let sourceTime = flowNow.addingTimeInterval(-899)
        let expiry = sourceTime.addingTimeInterval(15 * 60 + 0.001)
        #expect(expiry > flowNow)
        #expect(expiry.timeIntervalSince(flowNow) < 2)
        func cards(at now: Date) -> [DashboardPresentation.PowerCard] {
            let result = DashboardPresentation.powerFlow(
                solarPower: 754, loadPower: 1064, batteryPower: 310, gridPower: 0,
                sourceTime: sourceTime, isUnavailable: false, now: now
            )
            return result.supplying + result.receiving
        }
        #expect(cards(at: flowNow).contains { $0.role == .supplying })
        #expect(DashboardPresentation.liveFreshnessNotice(sourceTime, now: flowNow) == nil)
        #expect(cards(at: expiry).allSatisfy { $0.role == .unknown })
        #expect(DashboardPresentation.liveFreshnessNotice(sourceTime, now: expiry) != nil)
    }

    @Test("Battery direction matches website power threshold and signs")
    func batteryDirectionMatchesWebsitePowerThresholdAndSigns() {
        #expect(DashboardPresentation.batteryDirection(powerWatts: -51) == .charging)
        #expect(DashboardPresentation.batteryDirection(powerWatts: -50) == .idle)
        #expect(DashboardPresentation.batteryDirection(powerWatts: 50) == .idle)
        #expect(DashboardPresentation.batteryDirection(powerWatts: 51) == .discharging)
    }

    @Test("An unknown battery charge draws a blank battery, never a full one")
    func unknownChargeDrawsBlankBattery() {
        // A reading we cannot vouch for: no fill, and no bolt asserting flow the
        // blank fill denies. Matches the TRMNL renderer at fillWidth 0.
        #expect(DashboardPresentation.batterySymbol(powerWatts: 900, stateOfCharge: nil) == "battery.0percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: -900, stateOfCharge: nil) == "battery.0percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: nil) == "battery.0percent")
    }

    @Test("A known charge keeps its band and its charging bolt")
    func knownChargeKeepsBandAndBolt() {
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 0) == "battery.0percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 12) == "battery.0percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 13) == "battery.25percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 37) == "battery.25percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 38) == "battery.50percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 62) == "battery.50percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 63) == "battery.75percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 87) == "battery.75percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 0, stateOfCharge: 88) == "battery.100percent")
        #expect(DashboardPresentation.batterySymbol(powerWatts: -900, stateOfCharge: 50) == "battery.50percent.bolt")
        #expect(DashboardPresentation.batterySymbol(powerWatts: 900, stateOfCharge: 50) == "battery.50percent")
    }

    @Test("Battery header describes charge and direction without repeating power")
    func batteryHeaderDescribesChargeAndDirectionWithoutRepeatingPower() {
        #expect(DashboardPresentation.batteryDescription(stateOfCharge: nil, powerWatts: -250) == "Battery --, Charging")
        #expect(DashboardPresentation.batteryDescription(stateOfCharge: 0, powerWatts: 0) == "Battery 0%, Idle")
    }

    @Test("Power formatting formats watts as integers and kilowatts with one decimal place")
    func powerFormattingFormatsWattsAsIntegersAndKilowattsWithOneDecimalPlace() {
        #expect(DashboardPresentation.power(0) == "0 W")
        #expect(DashboardPresentation.power(444) == "444 W")
        #expect(DashboardPresentation.power(974.2) == "974 W")
        #expect(DashboardPresentation.power(-530) == "-530 W")
        #expect(DashboardPresentation.power(1000) == "1.0 kW")
        #expect(DashboardPresentation.power(-2400) == "-2.4 kW")
        #expect(DashboardPresentation.power(1800) == "1.8 kW")
    }

    @Test("Freshness uses the supplied source time and shows missing and stale states")
    func freshnessUsesTheSuppliedSourceTimeAndShowsMissingAndStaleStates() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(DashboardPresentation.freshness(now.addingTimeInterval(-60), now: now) == "Updated 1 min ago")
        #expect(DashboardPresentation.freshness(now.addingTimeInterval(-16 * 60), now: now) == "Stale · updated 16 min ago")
        #expect(DashboardPresentation.freshness(nil, now: now) == "Source time unavailable")
        #expect(DashboardPresentation.freshness(now.addingTimeInterval(60), now: now) == "Source time is in the future")
    }

    @Test("Currency uses currency code and nullable cost remains unavailable")
    func currencyUsesCurrencyCodeAndNullableCostRemainsUnavailable() {
        #expect(DashboardPresentation.currency(1234.5, code: "USD", locale: Locale(identifier: "en_US")) == "$1,234.50")
        #expect(DashboardPresentation.currency(nil, code: "USD", locale: Locale(identifier: "en_US")) == "Unavailable")
    }

    @Test("Formats load timing rates and balance with accessible labels")
    func loadTimingFormattingAndAccessibility() {
        #expect(DashboardPresentation.loadRate(0.04, code: "USD", locale: Locale(identifier: "en_US")) == "4¢/kWh")
        #expect(DashboardPresentation.loadRate(0.29, code: "USD", locale: Locale(identifier: "en_US")) == "29¢/kWh")
        #expect(DashboardPresentation.loadRate(0.57, code: "USD", locale: Locale(identifier: "en_US")) == "57¢/kWh")
        #expect(DashboardPresentation.loadRate(0.14, code: "USD", locale: Locale(identifier: "en_US")) == "14¢/kWh")
        #expect(DashboardPresentation.loadRate(0.12345, code: "USD", locale: Locale(identifier: "en_US")) == "12.34¢/kWh")
        #expect(DashboardPresentation.loadRate(0.04, code: "GBP", locale: Locale(identifier: "en_GB")) == "£0.04/kWh")
        #expect(DashboardPresentation.liveLoadBalance(3.25) == "Banked 3.3 kWh")
        #expect(DashboardPresentation.liveLoadBalance(-4) == "Owed 4.0 kWh")
        #expect(DashboardPresentation.liveLoadBalance(0) == "Even 0.0 kWh")
        #expect(DashboardPresentation.liveLoadBalance(nil) == "No bank yet")
        #expect(DashboardPresentation.liveLoadBalanceAccessibilityLabel(3.25) == "Banked 3.3 kilowatt-hours")
        #expect(DashboardPresentation.loadRateAccessibilityLabel(0.12, code: "USD", locale: Locale(identifier: "en_US")) == "12 cents per kilowatt-hour")
        #expect(DashboardPresentation.loadRateAccessibilityLabel(0.01, code: "USD", locale: Locale(identifier: "en_US")) == "1 cent per kilowatt-hour")
        #expect(DashboardPresentation.loadRateAccessibilityLabel(0.12345, code: "USD", locale: Locale(identifier: "en_US")) == "12.34 cents per kilowatt-hour")
    }

    @Test("Tariff period titles match website normalization")
    func tariffPeriodTitlesMatchWebsiteNormalization() {
        #expect(DashboardPresentation.tariffPeriodTitle("OFF_PEAK") == "Off-Peak")
        #expect(DashboardPresentation.tariffPeriodTitle("SUPER_OFF_PEAK") == "Super-Off-Peak")
        #expect(DashboardPresentation.tariffPeriodTitle("Off-Peak") == "Off-Peak")
        #expect(DashboardPresentation.tariffPeriodTitle("Regular String") == "Regular String")
        #expect(DashboardPresentation.tariffPeriodTitle("") == "")
    }

    @Test("Live freshness notice only appears when source needs attention")
    func liveFreshnessNoticeOnlyAppearsWhenSourceNeedsAttention() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(DashboardPresentation.liveFreshnessNotice(now.addingTimeInterval(-60), now: now) == nil)
        #expect(
            DashboardPresentation.liveFreshnessNotice(now.addingTimeInterval(-16 * 60), now: now)
                == "Stale · updated 16 min ago"
        )
        #expect(DashboardPresentation.liveFreshnessNotice(nil, now: now) == "Source time unavailable")
    }

    @Test("Home uses two columns only when wide, regular and not at accessibility sizes",
          arguments: [
              (700.0, true, false, true), (699.0, true, false, false),
              (1100.0, false, false, false), (1100.0, true, true, false),
          ])
    func homeColumns(width: Double, regular: Bool, accessibility: Bool, expected: Bool) {
        #expect(DashboardPresentation.homeUsesTwoColumns(
            width: width, isRegularWidth: regular, isAccessibilitySize: accessibility) == expected)
    }
}
