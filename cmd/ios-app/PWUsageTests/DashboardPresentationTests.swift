import XCTest
@testable import PWUsage

final class DashboardPresentationTests: XCTestCase {
    func testBatteryDirectionMatchesWebsitePowerThresholdAndSigns() {
        XCTAssertEqual(DashboardPresentation.batteryDirection(powerWatts: -51), .charging)
        XCTAssertEqual(DashboardPresentation.batteryDirection(powerWatts: -50), .idle)
        XCTAssertEqual(DashboardPresentation.batteryDirection(powerWatts: 50), .idle)
        XCTAssertEqual(DashboardPresentation.batteryDirection(powerWatts: 51), .discharging)
    }

    func testBatteryHeaderDescribesChargeAndDirectionWithoutRepeatingPower() {
        XCTAssertEqual(DashboardPresentation.batteryDescription(stateOfCharge: nil, powerWatts: -250), "Battery --, Charging")
        XCTAssertEqual(DashboardPresentation.batteryDescription(stateOfCharge: 0, powerWatts: 0), "Battery 0%, Idle")
    }

    func testGridAndBatteryDailySignsDescribeImportExportAndChargeDirection() {
        XCTAssertEqual(DashboardPresentation.signedGridEnergy(4.2), "↓ 4.2 kWh")
        XCTAssertEqual(DashboardPresentation.signedGridEnergy(-1.1), "↑ 1.1 kWh")
        XCTAssertEqual(DashboardPresentation.signedBatteryEnergy(3), "↓ 3.0 kWh")
        XCTAssertEqual(DashboardPresentation.signedBatteryEnergy(-2), "↑ 2.0 kWh")
    }

    func testTariffBalanceNamesSurplusAndDeficitFromNetGridEnergy() {
        XCTAssertEqual(DashboardPresentation.tariffBalance(-42.34), "Surplus 42.3 kWh")
        XCTAssertEqual(DashboardPresentation.tariffBalance(17.06), "Deficit 17.1 kWh")
        XCTAssertEqual(DashboardPresentation.tariffBalance(0), "Balanced 0.0 kWh")
    }

    func testFreshnessUsesTheSuppliedSourceTimeAndShowsMissingAndStaleStates() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(DashboardPresentation.freshness(now.addingTimeInterval(-60), now: now), "Updated 1 min ago")
        XCTAssertEqual(DashboardPresentation.freshness(now.addingTimeInterval(-16 * 60), now: now), "Stale · updated 16 min ago")
        XCTAssertEqual(DashboardPresentation.freshness(nil, now: now), "Source time unavailable")
        XCTAssertEqual(DashboardPresentation.freshness(now.addingTimeInterval(60), now: now), "Source time is in the future")
    }

    func testCurrencyUsesCurrencyCodeAndNullableCostRemainsUnavailable() {
        XCTAssertEqual(DashboardPresentation.currency(1234.5, code: "USD", locale: Locale(identifier: "en_US")), "$1,234.50")
        XCTAssertEqual(DashboardPresentation.currency(nil, code: "USD", locale: Locale(identifier: "en_US")), "Unavailable")
    }

    func testTariffPeriodTitlesMatchWebsiteNormalization() {
        XCTAssertEqual(DashboardPresentation.tariffPeriodTitle("OFF_PEAK"), "Off-Peak")
        XCTAssertEqual(DashboardPresentation.tariffPeriodTitle("SUPER_OFF_PEAK"), "Super-Off-Peak")
        XCTAssertEqual(DashboardPresentation.tariffPeriodTitle("Off-Peak"), "Off-Peak")
        XCTAssertEqual(DashboardPresentation.tariffPeriodTitle("Regular String"), "Regular String")
        XCTAssertEqual(DashboardPresentation.tariffPeriodTitle(""), "")
    }

    func testLiveFreshnessNoticeOnlyAppearsWhenSourceNeedsAttention() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertNil(DashboardPresentation.liveFreshnessNotice(now.addingTimeInterval(-60), now: now))
        XCTAssertEqual(
            DashboardPresentation.liveFreshnessNotice(now.addingTimeInterval(-16 * 60), now: now),
            "Stale · updated 16 min ago"
        )
        XCTAssertEqual(DashboardPresentation.liveFreshnessNotice(nil, now: now), "Source time unavailable")
    }

    func testOlderChargeIsClearlyDated() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertNil(DashboardPresentation.chargeAgeLabel(now.addingTimeInterval(-5 * 60), now: now))
        XCTAssertEqual(DashboardPresentation.chargeAgeLabel(now.addingTimeInterval(-30 * 60), now: now), "Charge as of 30 min ago")
    }
}
