import Foundation
import Testing
@testable import PWUsage

@Suite("Dashboard Presentation Tests")
struct DashboardPresentationTests {
    @Test("Battery direction matches website power threshold and signs")
    func batteryDirectionMatchesWebsitePowerThresholdAndSigns() {
        #expect(DashboardPresentation.batteryDirection(powerWatts: -51) == .charging)
        #expect(DashboardPresentation.batteryDirection(powerWatts: -50) == .idle)
        #expect(DashboardPresentation.batteryDirection(powerWatts: 50) == .idle)
        #expect(DashboardPresentation.batteryDirection(powerWatts: 51) == .discharging)
    }

    @Test("Battery header describes charge and direction without repeating power")
    func batteryHeaderDescribesChargeAndDirectionWithoutRepeatingPower() {
        #expect(DashboardPresentation.batteryDescription(stateOfCharge: nil, powerWatts: -250) == "Battery --, Charging")
        #expect(DashboardPresentation.batteryDescription(stateOfCharge: 0, powerWatts: 0) == "Battery 0%, Idle")
    }

    @Test("Battery power reports idle when under 10W")
    func batteryPowerReportsIdleWhenUnder10W() {
        #expect(DashboardPresentation.batteryPower(0) == "Idle")
        #expect(DashboardPresentation.batteryPower(5) == "Idle")
        #expect(DashboardPresentation.batteryPower(-9.9) == "Idle")
        #expect(DashboardPresentation.batteryPower(10) == "10 W")
        #expect(DashboardPresentation.batteryPower(-10) == "-10 W")
        #expect(DashboardPresentation.batteryPower(-2400) == "-2.4 kW")
        #expect(DashboardPresentation.batteryPower(1800) == "1.8 kW")

        #expect(DashboardPresentation.batteryPowerDetail(0) == nil)
        #expect(DashboardPresentation.batteryPowerDetail(9.9) == nil)
        #expect(DashboardPresentation.batteryPowerDetail(-9.9) == nil)
        #expect(DashboardPresentation.batteryPowerDetail(-10) == "Charging")
        #expect(DashboardPresentation.batteryPowerDetail(10) == "Discharging")
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

    @Test("Grid and battery daily signs describe import export and charge direction")
    func gridAndBatteryDailySignsDescribeImportExportAndChargeDirection() {
        #expect(DashboardPresentation.signedGridEnergy(4.2) == "↓ 4.2 kWh")
        #expect(DashboardPresentation.signedGridEnergy(-1.1) == "↑ 1.1 kWh")
        #expect(DashboardPresentation.signedBatteryEnergy(3) == "↓ 3.0 kWh")
        #expect(DashboardPresentation.signedBatteryEnergy(-2) == "↑ 2.0 kWh")
    }

    @Test("Tariff balance names surplus and deficit from net grid energy")
    func tariffBalanceNamesSurplusAndDeficitFromNetGridEnergy() {
        #expect(DashboardPresentation.tariffBalance(-42.34) == "Surplus 42.3 kWh")
        #expect(DashboardPresentation.tariffBalance(17.06) == "Deficit 17.1 kWh")
        #expect(DashboardPresentation.tariffBalance(0) == "Balanced 0.0 kWh")
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
        #expect(DashboardPresentation.loadRate(0.12345, code: "USD", locale: Locale(identifier: "en_US")) == "12.34¢/kWh")
        #expect(DashboardPresentation.loadRate(0.04, code: "GBP", locale: Locale(identifier: "en_GB")) == "£0.04/kWh")
        #expect(DashboardPresentation.loadBalance(-3.25) == "Surplus 3.3 kWh")
        #expect(DashboardPresentation.loadBalance(4) == "Deficit 4.0 kWh")
        #expect(DashboardPresentation.loadBalance(0) == "Balanced 0.0 kWh")
        #expect(DashboardPresentation.loadBalance(nil) == "No balance yet")
        #expect(DashboardPresentation.loadBalanceAccessibilityLabel(-3.25) == "Surplus 3.3 kilowatt-hours")
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

    @Test("Older charge is clearly dated")
    func olderChargeIsClearlyDated() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(DashboardPresentation.chargeAgeLabel(now.addingTimeInterval(-5 * 60), now: now) == nil)
        #expect(DashboardPresentation.chargeAgeLabel(now.addingTimeInterval(-30 * 60), now: now) == "Charge as of 30 min ago")
    }
}
