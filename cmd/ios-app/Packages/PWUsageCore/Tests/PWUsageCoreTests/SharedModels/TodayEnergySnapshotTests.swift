import Foundation
@testable import PWUsageCore
import Testing

@Suite("Today's Energy snapshot")
struct TodayEnergySnapshotTests {
    let now = Date(timeIntervalSince1970: 1_792_008_000)
    func snapshot() -> TodayEnergySnapshot {
        TodayEnergySnapshot(siteID: "home", siteName: "Home", timezone: "America/Chicago", fetchedAt: now,
                            energy: TodayEnergy(
                                localDate: TodayEnergySnapshot.localDate(now, timezone: "America/Chicago"),
                                homeKwh: 12, solarKwh: 18, gridNetKwh: -4,
                                batteryNetKwh: -2, energyDataThrough: now))
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
}
