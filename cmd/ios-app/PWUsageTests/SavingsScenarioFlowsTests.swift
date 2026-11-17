import Foundation
@testable import PWUsage
import Testing

@Suite("Savings Scenario Flows")
struct SavingsScenarioFlowsTests {
    private static let defaultBattery = SiteBatteryDTO(
        nameplateEnergyWh: 13_500,
        nameplatePowerW: 5_000,
        backupReservePercent: 20
    )

    @Test("Solar alone grid equals load minus solar")
    func solarAloneIsLoadMinusSolar() {
        let day = Self.makeDay(
            day: "2026-06-01",
            solar: [100, 500, 0],
            load: [300, 200, 150],
            grid: [200, -300, 150],
            battery: [0, 0, 0]
        )
        let result = SavingsScenarioFlows.build(days: [day], battery: nil)
        #expect(result.solarAlone[0].gridWh == [200, -300, 150])
    }

    @Test("No solar grid equals all load")
    func noSolarImportsAllLoad() {
        let day = Self.makeDay(
            day: "2026-06-01",
            solar: [100, 500, 0],
            load: [300, 200, 150],
            grid: [200, -300, 150],
            battery: [0, 0, 0]
        )
        let result = SavingsScenarioFlows.build(days: [day], battery: nil)
        #expect(result.noSolar[0].gridWh == [300, 200, 150])
    }

    @Test("Battery charges from surplus and covers evening down to reserve")
    func batteryChargesFromSurplusAndCoversEvening() {
        let middaySolar = Array(repeating: Float?(500), count: 12)
        let middayLoad = Array(repeating: Float?(250), count: 12)
        let eveningSolar = Array(repeating: Float?(0), count: 11)
        let eveningLoad = Array(repeating: Float?(250), count: 11)

        let solar = middaySolar + eveningSolar
        let load = middayLoad + eveningLoad
        let grid = Array(repeating: Float?(0), count: 23)
        let battery = [Float?(100)] + Array(repeating: Float?(0), count: 22)

        let day = Self.makeDay(day: "2026-06-01", solar: solar, load: load, grid: grid, battery: battery)
        let result = SavingsScenarioFlows.build(days: [day], battery: Self.defaultBattery)

        let s2Grid = result.batteryFixed[0].gridWh.compactMap(\.self)
        #expect(s2Grid.count == 23)
        // 12 midday slots: 0 grid; 8 evening slots: 0 grid; next 3 slots: 0, 0, 50
        #expect(Array(s2Grid.prefix(22)) == Array(repeating: Float(0), count: 22))
        #expect(abs(Double(s2Grid[22]) - 50.0) < 1e-4)
    }

    @Test("Battery never discharges below reserve")
    func batteryNeverDischargesBelowReserve() {
        let day = Self.makeDay(
            day: "2026-06-01",
            solar: [0, 0],
            load: [500, 500],
            grid: [0, 0],
            battery: [500, 500]
        )
        // Starts at 20% reserve -> cannot discharge at all
        let result = SavingsScenarioFlows.build(days: [day], battery: Self.defaultBattery)
        #expect(result.batteryFixed[0].gridWh == [500, 500])
    }

    @Test("Battery respects power limit per 5-minute slot")
    func batteryRespectsPowerLimitPerSlot() {
        // 5000 W * 5/60 h = 416.6667 Wh max per slot
        let maxPerSlot = 5_000.0 * 5.0 / 60.0
        let day = Self.makeDay(
            day: "2026-06-01",
            solar: [2_000, 0],
            load: [0, 1_000],
            grid: [-2_000, 1_000],
            battery: [100, 100]
        )
        let result = SavingsScenarioFlows.build(days: [day], battery: Self.defaultBattery)
        let slot0Grid = Double(result.batteryFixed[0].gridWh[0] ?? 0)
        let slot1Grid = Double(result.batteryFixed[0].gridWh[1] ?? 0)

        // Slot 0: surplus 2000, charges maxPerSlot -> exports (2000 - maxPerSlot)
        #expect(abs(slot0Grid - (maxPerSlot - 2_000.0)) < 1e-3)
        // Slot 1: stored = maxPerSlot * 0.9, discharges min(maxPerSlot * 0.9, maxPerSlot) = maxPerSlot * 0.9
        let stored = maxPerSlot * 0.9
        #expect(abs(slot1Grid - (1_000.0 - stored)) < 1e-3)
    }

    @Test("Energy balances in every slot")
    func energyBalancesEverySlot() {
        let day = Self.makeDay(
            day: "2026-06-01",
            solar: [0, 600, 100, nil],
            load: [300, 200, 400, 200],
            grid: [300, -400, 300, 200],
            battery: [100, 0, 0, 0]
        )
        let result = SavingsScenarioFlows.build(days: [day], battery: Self.defaultBattery)
        for index in 0 ..< 4 {
            let load = Double(day.loadWh[index] ?? 0)
            let solar = Double(day.solarWh[index] ?? 0)
            let s3Grid = Double(result.solarAlone[0].gridWh[index] ?? 0)
            let s4Grid = Double(result.noSolar[0].gridWh[index] ?? 0)
            #expect(abs((solar + s3Grid) - load) < 1e-9)
            #expect(abs(s4Grid - load) < 1e-9)
        }
    }

    @Test("No battery makes scenario 2 equal scenario 3")
    func noBatteryMakesScenarioTwoEqualThree() {
        let day = Self.makeDay(
            day: "2026-06-01",
            solar: [500, 0],
            load: [100, 300],
            grid: [-400, 300],
            battery: [0, 0]
        )
        let result = SavingsScenarioFlows.build(days: [day], battery: nil)
        #expect(result.batteryStartDay == nil)
        #expect(result.batteryFixed == result.solarAlone)
    }

    @Test("Scenarios cover only slots with recorded grid and load")
    func scenariosCoverOnlyRecordedGridSlots() {
        let day = Self.makeDay(
            day: "2026-06-01",
            solar: [400, nil, 100],
            load: [200, 200, nil],
            grid: [nil, 200, 100],
            battery: [100, 0, 0]
        )
        let result = SavingsScenarioFlows.build(days: [day], battery: Self.defaultBattery)
        // Slot 0: grid nil -> stays nil in all scenarios
        #expect(result.batteryFixed[0].gridWh[0] == nil)
        #expect(result.solarAlone[0].gridWh[0] == nil)
        #expect(result.noSolar[0].gridWh[0] == nil)
        // Slot 1: solar nil counts as 0
        #expect(result.solarAlone[0].gridWh[1] == 200)
        #expect(result.noSolar[0].gridWh[1] == 200)
        // Slot 2: load nil -> stays nil in all scenarios
        #expect(result.batteryFixed[0].gridWh[2] == nil)
        #expect(result.solarAlone[0].gridWh[2] == nil)
        #expect(result.noSolar[0].gridWh[2] == nil)
    }

    @Test("Battery state carries across DST days and date gaps")
    func batteryStateCarriesAcrossDstAndGaps() {
        // Day 1 (276 slots, DST spring forward): charges (400 + 400) * 0.9 = 720 Wh above reserve
        let day1 = Self.makeDay(
            day: "2026-03-08",
            dayOffset: 0,
            solar: [400, 400] + Array(repeating: Float?(0), count: 274),
            load: Array(repeating: Float?(0), count: 276),
            grid: Array(repeating: Float?(0), count: 276),
            battery: [100] + Array(repeating: Float?(0), count: 275)
        )
        // Gap of 2 days, then Day 2 (300 slots, DST fall back): uses 500 Wh load
        let day2 = Self.makeDay(
            day: "2026-11-01",
            dayOffset: 3,
            solar: Array(repeating: Float?(0), count: 300),
            load: [500] + Array(repeating: Float?(0), count: 299),
            grid: Array(repeating: Float?(0), count: 300),
            battery: Array(repeating: Float?(0), count: 300)
        )
        let result = SavingsScenarioFlows.build(days: [day2, day1], battery: Self.defaultBattery)
        // Day 2 slot 0: load 500 Wh, max discharge 416.6667 Wh (5000 W * 5/60) -> grid = 500 - 416.6667 = 83.3333
        let expectedGrid = 500.0 - (5_000.0 * 5.0 / 60.0)
        #expect(abs(Double(result.batteryFixed[1].gridWh[0] ?? -1) - expectedGrid) < 1e-3)
    }

    @Test("Days before batteryStartDay match solarAlone")
    func daysBeforeBatteryStartMatchSolarAlone() {
        let day1 = Self.makeDay(
            day: "2026-06-01",
            dayOffset: 0,
            solar: [500, 0],
            load: [100, 300],
            grid: [-400, 300],
            battery: [0, 0]
        )
        let day2 = Self.makeDay(
            day: "2026-06-02",
            dayOffset: 1,
            solar: [500, 0],
            load: [100, 300],
            grid: [-400, 300],
            battery: [100, -100]
        )
        let result = SavingsScenarioFlows.build(days: [day1, day2], battery: Self.defaultBattery)
        #expect(result.batteryStartDay == "2026-06-02")
        // Day 1 before batteryStartDay: S2 == S3
        #expect(result.batteryFixed[0] == result.solarAlone[0])
        // Day 2 on batteryStartDay: S2 charges 400*0.9=360 on slot 0 (grid 0), discharges 300 on slot 1 (grid 0)
        #expect(result.batteryFixed[1].gridWh == [0, 0])
    }

    @Test("Powerwall start override replaces the first battery-flow day")
    func batteryStartOverrideReplacesFirstFlowDay() {
        let day1 = Self.makeDay(
            day: "2026-06-01",
            dayOffset: 0,
            solar: [500, 0],
            load: [100, 300],
            grid: [-400, 300],
            battery: [0, 0]
        )
        let day2 = Self.makeDay(
            day: "2026-06-02",
            dayOffset: 1,
            solar: [500, 0],
            load: [100, 300],
            grid: [-400, 300],
            battery: [100, -100]
        )
        let day3 = Self.makeDay(
            day: "2026-06-03",
            dayOffset: 2,
            solar: [500, 0],
            load: [100, 300],
            grid: [-400, 300],
            battery: [0, 0]
        )
        let result = SavingsScenarioFlows.build(
            days: [day1, day2, day3],
            battery: Self.defaultBattery,
            batteryStartOverride: "2026-06-03"
        )
        #expect(result.batteryStartDay == "2026-06-03")
        // Days before the override match solarAlone, even the day with battery flow
        #expect(result.batteryFixed[0] == result.solarAlone[0])
        #expect(result.batteryFixed[1] == result.solarAlone[1])
        // The override day starts the battery: it charges on slot 0 and discharges on slot 1
        #expect(result.batteryFixed[2].gridWh == [0, 0])
    }

    @Test("Powerwall start override before the first battery-flow day starts the simulation earlier")
    func overrideBeforeFirstFlowStartsSimulationEarlier() {
        let day1 = Self.makeDay(
            day: "2026-06-01",
            dayOffset: 0,
            solar: [500, 0],
            load: [100, 300],
            grid: [-400, 300],
            battery: [0, 0]
        )
        let day2 = Self.makeDay(
            day: "2026-06-02",
            dayOffset: 1,
            solar: [0, 0],
            load: [0, 0],
            grid: [0, 0],
            battery: [100, -100]
        )
        let withoutOverride = SavingsScenarioFlows.build(days: [day1, day2], battery: Self.defaultBattery)
        let withOverride = SavingsScenarioFlows.build(
            days: [day1, day2],
            battery: Self.defaultBattery,
            batteryStartOverride: "2026-06-01"
        )
        #expect(withoutOverride.batteryStartDay == "2026-06-02")
        #expect(withoutOverride.batteryFixed[0] == withoutOverride.solarAlone[0])
        #expect(withOverride.batteryStartDay == "2026-06-01")
        #expect(withOverride.batteryFixed[0].gridWh == [0, 0])
    }

    private static func makeDay(
        day: String,
        dayOffset: Int = 0,
        solar: [Float?],
        load: [Float?],
        grid: [Float?],
        battery: [Float?]
    ) -> EnergyFlowDay {
        let base = Date(timeIntervalSince1970: 1_780_272_000 + Double(dayOffset) * 86_400)
        return EnergyFlowDay(
            day: day,
            dayStart: base,
            solarWh: solar,
            loadWh: load,
            gridWh: grid,
            batteryWh: battery,
            batterySoc: Array(repeating: nil, count: grid.count)
        )
    }
}
