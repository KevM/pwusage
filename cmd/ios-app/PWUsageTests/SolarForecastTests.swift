import Foundation
@testable import PWUsage
import Testing

@Suite("Solar Forecast Aggregation Tests")
struct SolarForecastTests {
    @Test("Integrates 4 kW over a half hour to 2 kWh")
    func integratesPowerOverDuration() throws {
        let interval = interval("12:00", "12:30", power: 4)
        #expect(try interval.energyKwh() == 2)
    }

    @Test("Integrates partial overlaps across adjacent intervals")
    func integratesPartialRunOverlaps() throws {
        let forecast = [interval("12:00", "12:30", power: 2), interval("12:30", "13:00", power: 4)]
        let energy = try SolarForecast.energy(in: forecast, from: date("12:15"), to: date("12:45"))
        #expect(energy == 1.5)
    }

    @Test("Preserves explicit nighttime zero as known production")
    func preservesExplicitZero() throws {
        let forecast = [interval("12:00", "12:30", power: 0)]
        #expect(try SolarForecast.energy(in: forecast, from: date("12:00"), to: date("12:30")) == 0)
    }

    @Test("Rejects overlapping arbitrary intervals during integration")
    func rejectsOverlappingIntervals() {
        let start = date("12:00")
        let middle = date("12:30")
        let end = date("13:00")
        let intervals = [
            SolarForecastInterval(periodStart: start, periodEnd: end, powerKw: 1),
            SolarForecastInterval(periodStart: middle, periodEnd: date("13:30"), powerKw: 1),
        ]
        #expect(throws: SolarForecastError.incompleteCoverage) {
            try SolarForecast.energy(in: intervals, from: start, to: date("13:30"))
        }
    }

    @Test("Rejects overflow in interval and partial energy calculations")
    func rejectsEnergyOverflow() throws {
        let start = date("12:00")
        let end = date("14:00")
        let interval = SolarForecastInterval(periodStart: start, periodEnd: end, powerKw: .greatestFiniteMagnitude)
        #expect(throws: SolarForecastError.nonFiniteValue) { try interval.energyKwh() }
        #expect(throws: SolarForecastError.nonFiniteValue) {
            try SolarForecast.energy(in: [interval], from: start, to: end)
        }

        let middle = date("13:00")
        let largeButFinitePower = Double.greatestFiniteMagnitude * 0.75
        let firstHour = SolarForecastInterval(periodStart: start, periodEnd: middle, powerKw: largeButFinitePower)
        let secondHour = SolarForecastInterval(periodStart: middle, periodEnd: end, powerKw: largeButFinitePower)
        #expect(throws: SolarForecastError.nonFiniteValue) {
            try SolarForecast.energy(in: [firstHour, secondHour], from: start, to: end)
        }
    }

    @Test("Rejects a gap in the requested integration range")
    func rejectsGaps() throws {
        let forecast = [interval("12:00", "12:30", power: 2), interval("13:00", "13:30", power: 2)]
        #expect(throws: SolarForecastError.incompleteCoverage) {
            try SolarForecast.energy(in: forecast, from: date("12:00"), to: date("13:30"))
        }
    }

    @Test("oldBatchDecodesWithoutCautiousSolar")
    func oldBatchDecodesWithoutCautiousSolar() throws {
        let stored = Data(#"[{"periodStart":0,"periodEnd":1800,"powerKw":2.5}]"#.utf8)
        let intervals = try JSONDecoder().decode([SolarForecastInterval].self, from: stored)
        #expect(intervals.first?.powerKw == 2.5)
        #expect(intervals.first?.cautiousPowerKw == nil)

        let roundTrip = try JSONDecoder().decode(
            [SolarForecastInterval].self,
            from: JSONEncoder().encode([
                SolarForecastInterval(
                    periodStart: .init(timeIntervalSinceReferenceDate: 0),
                    periodEnd: .init(timeIntervalSinceReferenceDate: 1800),
                    powerKw: 2, cautiousPowerKw: 0.5
                )])
        )
        #expect(roundTrip.first?.cautiousPowerKw == 0.5)
    }

    private func interval(
        _ start: String, _ end: String, power: Double, cautious: Double? = nil
    ) -> SolarForecastInterval {
        SolarForecastInterval(periodStart: date(start), periodEnd: date(end), powerKw: power, cautiousPowerKw: cautious)
    }

    private func date(_ time: String) -> Date {
        let parts = time.split(separator: ":").compactMap { Int($0) }
        let components = DateComponents(
            timeZone: TimeZone(secondsFromGMT: 0), year: 2026, month: 9, day: 27,
            hour: parts[0], minute: parts[1]
        )
        guard let date = Calendar(identifier: .gregorian).date(from: components) else {
            preconditionFailure("Invalid test date: \(time)")
        }
        return date
    }
}
