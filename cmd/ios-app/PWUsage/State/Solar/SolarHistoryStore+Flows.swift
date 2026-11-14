import Foundation

struct EnergyFlowDay: Equatable, Sendable {
    let day: String
    let dayStart: Date
    let solarWh: [Float?]
    let loadWh: [Float?]
    let gridWh: [Float?]
    let batteryWh: [Float?]
    let batterySoc: [Float?]
}

extension SolarHistoryStore {
    /// Energy flows for every stored day in `[startDate, endDate]`, or `nil` when any day in range
    /// lacks one of the four flow series. Gaps inside `batterySoc` are normal and never mark a day unready.
    func flowDays(scope: SolarForecastSiteScope, from startDate: Date, to endDate: Date) throws -> [EnergyFlowDay]? {
        let state = try load(scope)
        let daysInRange = state.days
            .filter { $0.dayStart >= startDate && $0.dayStart <= endDate }
            .sorted { $0.dayStart < $1.dayStart }
        guard !daysInRange.isEmpty else { return [] }
        guard let zone = state.timeZone.flatMap(TimeZone.init(identifier:)) else { return nil }
        var result: [EnergyFlowDay] = []
        result.reserveCapacity(daysInRange.count)
        for stored in daysInRange {
            guard let load = stored.load,
                  let grid = stored.grid,
                  let battery = stored.battery,
                  let soc = stored.soc else {
                return nil
            }
            result.append(EnergyFlowDay(
                day: Self.dayString(stored.dayStart, timeZone: zone),
                dayStart: stored.dayStart,
                solarWh: stored.slots,
                loadWh: load,
                gridWh: grid,
                batteryWh: battery,
                batterySoc: soc
            ))
        }
        return result
    }

    /// Oldest stored site-local day lacking any of the four flow series, or `nil` when all are ready.
    func oldestDayMissingFlows(scope: SolarForecastSiteScope) throws -> String? {
        let state = try load(scope)
        guard let zone = state.timeZone.flatMap(TimeZone.init(identifier:)),
              let oldest = state.days
                  .filter({ $0.load == nil || $0.grid == nil || $0.battery == nil || $0.soc == nil })
                  .min(by: { $0.dayStart < $1.dayStart }) else {
            return nil
        }
        return Self.dayString(oldest.dayStart, timeZone: zone)
    }

    static func makeStoredDay(from day: MobileSolarHistoryDay) -> SolarHistoryStoredDay {
        SolarHistoryStoredDay(
            dayStart: day.dayStart,
            slots: day.solarWh.map { $0.map(Float.init) },
            load: day.loadWh.map { $0.map(Float.init) },
            grid: day.gridWh.map { $0.map(Float.init) },
            battery: day.batteryWh.map { $0.map(Float.init) },
            soc: day.batterySoc.map { $0.map(Float.init) }
        )
    }
}
