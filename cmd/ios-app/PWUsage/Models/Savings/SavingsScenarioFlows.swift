import Foundation

struct SavingsScenarioDays: Equatable, Sendable {
    let recorded: [EnergyFlowDay]
    let batteryFixed: [EnergyFlowDay]
    let solarAlone: [EnergyFlowDay]
    let noSolar: [EnergyFlowDay]
    let batteryStartDay: String?
}

enum SavingsScenarioFlows {
    private static let batteryThresholdWh: Double = 1.0
    private static let slotHours: Double = 5.0 / 60.0

    private struct BatteryModel {
        let capacityWh: Double
        let reserveWh: Double
        let maxSlotWh: Double
        let efficiency: Double
        var stateWh: Double

        init?(battery: SiteBatteryDTO?, efficiency: Double) {
            guard let battery, battery.nameplateEnergyWh > 0, efficiency > 0 else { return nil }
            let clampedReserve = min(max(battery.backupReservePercent / 100.0, 0), 1)
            self.capacityWh = battery.nameplateEnergyWh
            self.reserveWh = capacityWh * clampedReserve
            self.maxSlotWh = max(0, battery.nameplatePowerW) * SavingsScenarioFlows.slotHours
            self.efficiency = efficiency
            self.stateWh = reserveWh
        }

        mutating func step(loadWh: Double, solarWh: Double) -> Double {
            let net = loadWh - solarWh
            if net < 0 {
                let surplus = -net
                let headroom = max(0, capacityWh - stateWh)
                let charged = min(surplus, maxSlotWh, headroom / efficiency)
                stateWh += charged * efficiency
                return net + charged
            }
            let available = max(0, stateWh - reserveWh)
            let discharged = min(net, maxSlotWh, available)
            stateWh -= discharged
            return net - discharged
        }
    }

    static func build(
        days: [EnergyFlowDay],
        battery: SiteBatteryDTO?,
        batteryStartOverride: String? = nil,
        roundTripEfficiency: Double = 0.9
    ) -> SavingsScenarioDays {
        let sortedDays = days.sorted { $0.dayStart < $1.dayStart }
        let batteryStartIndex = if let batteryStartOverride {
            // The owner's Powerwall install day starts the battery on the first stored day at or after it.
            // An override before the first stored day starts the battery on that first day.
            sortedDays.firstIndex { $0.day >= batteryStartOverride }
        } else {
            sortedDays.firstIndex { day in
                day.batteryWh.contains { value in
                    guard let value else { return false }
                    return abs(Double(value)) > batteryThresholdWh
                }
            }
        }
        let batteryStartDay = batteryStartIndex.map { sortedDays[$0].day }
        var model = batteryStartIndex == nil ? nil : BatteryModel(battery: battery, efficiency: roundTripEfficiency)

        var batteryFixedDays: [EnergyFlowDay] = []
        var solarAloneDays: [EnergyFlowDay] = []
        var noSolarDays: [EnergyFlowDay] = []
        batteryFixedDays.reserveCapacity(sortedDays.count)
        solarAloneDays.reserveCapacity(sortedDays.count)
        noSolarDays.reserveCapacity(sortedDays.count)

        for (index, day) in sortedDays.enumerated() {
            let isBatteryActive = batteryStartIndex.map { index >= $0 } ?? false
            let grids = deriveDayGrids(
                day: day,
                useBattery: isBatteryActive,
                model: &model
            )
            batteryFixedDays.append(replacingGrid(in: day, with: grids.batteryFixed))
            solarAloneDays.append(replacingGrid(in: day, with: grids.solarAlone))
            noSolarDays.append(replacingGrid(in: day, with: grids.noSolar))
        }

        return SavingsScenarioDays(
            recorded: sortedDays,
            batteryFixed: batteryFixedDays,
            solarAlone: solarAloneDays,
            noSolar: noSolarDays,
            batteryStartDay: batteryStartDay
        )
    }

    private struct DayGrids {
        let batteryFixed: [Float?]
        let solarAlone: [Float?]
        let noSolar: [Float?]
    }

    private static func deriveDayGrids(
        day: EnergyFlowDay,
        useBattery: Bool,
        model: inout BatteryModel?
    ) -> DayGrids {
        let count = day.gridWh.count
        var s2Grid = Array(repeating: Float?.none, count: count)
        var s3Grid = Array(repeating: Float?.none, count: count)
        var s4Grid = Array(repeating: Float?.none, count: count)

        for index in 0 ..< count {
            guard day.gridWh[index] != nil,
                  index < day.loadWh.count,
                  let rawLoad = day.loadWh[index] else {
                continue
            }
            let loadWh = Double(rawLoad)
            let rawSolar = index < day.solarWh.count ? day.solarWh[index] : nil
            let solarWh = Double(rawSolar ?? 0)
            let solarAloneWh = loadWh - solarWh

            s3Grid[index] = Float(solarAloneWh)
            s4Grid[index] = Float(loadWh)
            if useBattery, model != nil {
                let s2Value = model?.step(loadWh: loadWh, solarWh: solarWh) ?? solarAloneWh
                s2Grid[index] = Float(s2Value)
            } else {
                s2Grid[index] = Float(solarAloneWh)
            }
        }
        return DayGrids(batteryFixed: s2Grid, solarAlone: s3Grid, noSolar: s4Grid)
    }

    private static func replacingGrid(in day: EnergyFlowDay, with gridWh: [Float?]) -> EnergyFlowDay {
        EnergyFlowDay(
            day: day.day,
            dayStart: day.dayStart,
            solarWh: day.solarWh,
            loadWh: day.loadWh,
            gridWh: gridWh,
            batteryWh: day.batteryWh,
            batterySoc: day.batterySoc
        )
    }
}
