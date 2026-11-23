import Foundation
import PWUsageCore

extension DemoFixtures {
    /// Days of 5-minute flows ending at `asOf`, so savings and the local bill have history to price.
    /// Midday solar covers the load and exports; the evening draws from the grid; the battery rests.
    /// Today holds readings only up to `asOf`.
    static func solarHistoryDays(from startDay: String, asOf: Date, maxDays: Int = 120) -> [MobileSolarHistoryDay] {
        let calendar = calendar
        let today = calendar.startOfDay(for: asOf)
        guard let earliest = calendar.date(byAdding: .day, value: -(maxDays - 1), to: today) else { return [] }
        let parts = startDay.split(separator: "-").compactMap { Int($0) }
        let requested = parts.count == 3
            ? calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) : nil
        var dayStart = max(requested ?? earliest, earliest)
        var days: [MobileSolarHistoryDay] = []
        while dayStart <= today, let next = calendar.date(byAdding: .day, value: 1, to: dayStart) {
            let slotCount = Int(next.timeIntervalSince(dayStart) / 300)
            var solar: [Double?] = []
            var load: [Double?] = []
            var grid: [Double?] = []
            for slot in 0 ..< slotCount {
                let slotStart = dayStart.addingTimeInterval(Double(slot) * 300)
                guard slotStart < asOf else {
                    solar.append(nil); load.append(nil); grid.append(nil)
                    continue
                }
                let hour = calendar.component(.hour, from: slotStart)
                let solarWh = solarKw(hour: hour) * 1000 / 12
                let loadWh = (17 ..< 21).contains(hour) ? 75.0 : 30.0
                solar.append(solarWh)
                load.append(loadWh)
                grid.append(loadWh - solarWh)
            }
            let isToday = dayStart == today
            days.append(MobileSolarHistoryDay(
                day: localDateText(dayStart), dayStart: dayStart, status: isToday ? .open : .complete,
                fetchedAt: source(asOf), solarWh: solar, loadWh: load, gridWh: grid,
                batteryWh: solar.map { $0 == nil ? nil : 0 },
                batterySoc: solar.map { $0 == nil ? nil : Double(stateOfCharge) }
            ))
            dayStart = next
        }
        return days
    }
}
