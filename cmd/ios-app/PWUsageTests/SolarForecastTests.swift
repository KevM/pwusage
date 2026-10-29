import Foundation
@testable import PWUsage
import Testing

@Suite("Solar Forecast Aggregation Tests")
struct SolarForecastTests {
    @Test("Combines selected arrays by exact UTC interval despite shuffled order")
    func combinesByIntervalRatherThanArrayPosition() throws {
        let first = [point("12:30", power: 1), point("13:00", power: 0)]
        let second = [point("13:00", power: 2), point("12:30", power: 3)]
        let combined = try SolarForecast.combine([first, second])
        #expect(combined.map(\.powerKw) == [4, 2])
        #expect(combined.map(\.periodStart) == [date("12:00"), date("12:30")])
    }

    @Test("Integrates 4 kW over a half hour to 2 kWh")
    func integratesPowerOverDuration() throws {
        let forecast = try SolarForecast.combine([[point("12:30", power: 4)]])
        #expect(try forecast[0].energyKwh() == 2)
    }

    @Test("Integrates partial overlaps across adjacent intervals")
    func integratesPartialRunOverlaps() throws {
        let forecast = try SolarForecast.combine([[point("12:30", power: 2), point("13:00", power: 4)]])
        let energy = try SolarForecast.energy(in: forecast, from: date("12:15"), to: date("12:45"))
        #expect(energy == 1.5)
    }

    @Test("Preserves explicit nighttime zero as known production")
    func preservesExplicitZero() throws {
        let forecast = try SolarForecast.combine([[point("12:30", power: 0)]])
        #expect(try SolarForecast.energy(in: forecast, from: date("12:00"), to: date("12:30")) == 0)
    }

    @Test("Rejects duplicate intervals instead of double counting")
    func rejectsDuplicateIntervals() throws {
        #expect(throws: SolarForecastError.duplicateInterval) {
            try SolarForecast.combine([[point("12:30", power: 1), point("12:30", power: 1)]])
        }
    }

    @Test("Rejects overlapping arbitrary intervals during integration")
    func rejectsOverlappingIntervals() {
        let start = date("12:00")
        let middle = date("12:30")
        let end = date("13:00")
        let intervals = [
            SolarForecastInterval(periodStart: start, periodEnd: end, powerKw: 1),
            SolarForecastInterval(periodStart: middle, periodEnd: date("13:30"), powerKw: 1)
        ]
        #expect(throws: SolarForecastError.incompleteCoverage) {
            try SolarForecast.energy(in: intervals, from: start, to: date("13:30"))
        }
    }

    @Test("Rejects overflow in summed interval power")
    func rejectsSummedPowerOverflow() {
        #expect(throws: SolarForecastError.nonFiniteValue) {
            try SolarForecast.combine([[point("12:30", power: .greatestFiniteMagnitude)], [point("12:30", power: .greatestFiniteMagnitude)]])
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

        let forecastPoint = SolcastForecastPoint(periodEnd: end, periodDuration: 7200, pvEstimateKw: .greatestFiniteMagnitude, pvEstimate10Kw: nil, pvEstimate90Kw: nil)
        #expect(throws: SolarForecastError.nonFiniteValue) { try SolarForecast.combine([[forecastPoint]]) }

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
        let forecast = try SolarForecast.combine([[point("12:30", power: 2), point("13:30", power: 2)]])
        #expect(throws: SolarForecastError.incompleteCoverage) {
            try SolarForecast.energy(in: forecast, from: date("12:00"), to: date("13:30"))
        }
    }

    @Test("Requires every selected array and matching period boundaries")
    func rejectsAbsentOrMismatchedArrayIntervals() {
        #expect(throws: SolarForecastError.incompleteCoverage) {
            try SolarForecast.combine([[point("12:30", power: 1)], []])
        }
        #expect(throws: SolarForecastError.incompleteCoverage) {
            try SolarForecast.combine([[point("12:30", power: 1)], [point("13:00", power: 1)]])
        }
    }

    @Test("combineKeepsCautiousSolar")
    func combineKeepsCautiousSolar() throws {
        let first = [point("12:30", power: 4, cautious: 1), point("13:00", power: 2, cautious: 0.5)]
        let second = [point("12:30", power: 1, cautious: 0.25), point("13:00", power: 1, cautious: 0)]
        let combined = try SolarForecast.combine([first, second])
        #expect(combined.map(\.powerKw) == [5, 3])
        #expect(combined.map(\.cautiousPowerKw) == [1.25, 0.5])

        let partial = try SolarForecast.combine([first, [point("12:30", power: 1), point("13:00", power: 1)]])
        #expect(partial.map(\.cautiousPowerKw) == [nil, nil])
    }

    @Test("oldBatchDecodesWithoutCautiousSolar")
    func oldBatchDecodesWithoutCautiousSolar() throws {
        let stored = Data(#"[{"periodStart":0,"periodEnd":1800,"powerKw":2.5}]"#.utf8)
        let intervals = try JSONDecoder().decode([SolarForecastInterval].self, from: stored)
        #expect(intervals.first?.powerKw == 2.5)
        #expect(intervals.first?.cautiousPowerKw == nil)

        let roundTrip = try JSONDecoder().decode(
            [SolarForecastInterval].self,
            from: JSONEncoder().encode([SolarForecastInterval(periodStart: .init(timeIntervalSinceReferenceDate: 0), periodEnd: .init(timeIntervalSinceReferenceDate: 1800), powerKw: 2, cautiousPowerKw: 0.5)])
        )
        #expect(roundTrip.first?.cautiousPowerKw == 0.5)
    }

    private func point(_ end: String, power: Double, cautious: Double) -> SolcastForecastPoint {
        SolcastForecastPoint(periodEnd: date(end), periodDuration: 1800, pvEstimateKw: power, pvEstimate10Kw: cautious, pvEstimate90Kw: nil)
    }

    private func point(_ end: String, power: Double) -> SolcastForecastPoint {
        let value = SolcastForecastPoint(periodEnd: date(end), periodDuration: 1800, pvEstimateKw: power, pvEstimate10Kw: nil, pvEstimate90Kw: nil)
        return value
    }

    private func date(_ time: String) -> Date {
        let parts = time.split(separator: ":").compactMap { Int($0) }
        return Calendar(identifier: .gregorian).date(from: DateComponents(timeZone: TimeZone(secondsFromGMT: 0), year: 2026, month: 9, day: 27, hour: parts[0], minute: parts[1]))!
    }
}
