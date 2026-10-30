import Foundation
@testable import PWUsage
import Testing

@Suite("Solar forecast correction")
struct SolarForecastCorrectionTests {
    private typealias Fixture = SolarProviderFixture
    private static let chicago = Fixture.chicago
    private static let now = Fixture.date("2026-10-29 06:00:00")

    /// Fourteen past days of daylight hours (07:00–17:00 local) at `forecastWh`, with actuals
    /// from `actual(localHour, forecastWh)`.
    private static func samples(
        days: Int = 14,
        hours: ClosedRange<Int> = 7 ... 17,
        forecastWh: Double = 1000,
        complete: Bool = true,
        actual: (Int, Double) -> Double
    ) -> (forecast: [Date: Double], actuals: [MobileSolarActualsHour]) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = chicago
        let today = calendar.startOfDay(for: now)
        var forecast: [Date: Double] = [:]
        var actuals: [MobileSolarActualsHour] = []
        for back in 1 ... days {
            guard let day = calendar.date(byAdding: .day, value: -back, to: today) else { continue }
            for hour in hours {
                guard let start = calendar.date(byAdding: .hour, value: hour, to: day) else { continue }
                forecast[start] = forecastWh
                actuals.append(MobileSolarActualsHour(
                    hourStart: start, energyWh: actual(hour, forecastWh), complete: complete
                ))
            }
        }
        return (forecast, actuals)
    }

    private static func derive(_ data: (forecast: [Date: Double], actuals: [MobileSolarActualsHour]))
        -> SolarForecastCorrection {
        SolarForecastCorrection.derive(
            pastForecastWh: data.forecast, actuals: data.actuals, siteTimeZone: chicago, now: now
        )
    }

    @Test("Actual at 80% of forecast every hour gives 0.8 everywhere")
    func uniformFactor() {
        let correction = Self.derive(Self.samples { _, forecast in forecast * 0.8 })
        #expect((7 ... 17).allSatisfy { abs(correction.factor(forLocalHour: $0) - 0.8) < 1e-9 })
        #expect(abs(correction.fallbackFactor - 0.8) < 1e-9)
    }

    @Test("Morning and afternoon hours get their own factors")
    func hourlyFactors() {
        let correction = Self.derive(Self.samples { hour, forecast in hour < 12 ? forecast * 0.5 : forecast * 1.2 })
        #expect(abs(correction.factor(forLocalHour: 9) - 0.5) < 1e-9)
        #expect(abs(correction.factor(forLocalHour: 14) - 1.2) < 1e-9)
    }

    @Test("Factors are clamped to 0.5…1.5")
    func clamping() {
        #expect(Self.derive(Self.samples { _, forecast in forecast * 3 }).factor(forLocalHour: 10) == 1.5)
        #expect(Self.derive(Self.samples { _, _ in 0 }).factor(forLocalHour: 10) == 0.5)
    }

    @Test("An hour with four samples uses the all-day factor; no data is identity")
    func sparseHours() {
        var data = Self.samples { _, forecast in forecast * 0.8 }
        let sparse = Self.samples(days: 4, hours: 18 ... 18) { _, forecast in forecast * 1.4 }
        data.forecast.merge(sparse.forecast) { first, _ in first }
        data.actuals += sparse.actuals
        let correction = Self.derive(data)
        #expect(correction.factor(forLocalHour: 18) == correction.fallbackFactor)
        #expect(Self.derive(([:], [])) == .identity)
    }

    @Test("Incomplete actuals and small forecasts never train")
    func ignoredSamples() {
        #expect(Self.derive(Self.samples(complete: false) { _, forecast in forecast * 0.8 }) == .identity)
        #expect(Self.derive(Self.samples(forecastWh: 50) { _, forecast in forecast * 0.8 }) == .identity)
    }

    @Test("Hours outside the trailing 14 local days or in the future do not train")
    func trainingWindow() {
        let old = Self.samples(days: 20, hours: 9 ... 9) { _, forecast in forecast * 0.6 }
        let correction = Self.derive(old)
        let recent = Self.derive(Self.samples(days: 14, hours: 9 ... 9) { _, forecast in forecast * 0.6 })
        #expect(correction == recent)
        let future = Fixture.date("2026-10-29 09:00:00")
        let futureOnly = Self.derive((
            [future: 1000],
            [MobileSolarActualsHour(hourStart: future, energyWh: 500, complete: true)]
        ))
        #expect(futureOnly == .identity)
    }

    @Test("Factors follow the site's local hour, not the device's")
    func siteLocalHour() {
        let correction = Self.derive(Self.samples { hour, forecast in hour == 9 ? forecast * 0.6 : forecast })
        let start = Fixture.date("2026-10-29 09:00:00")
        let interval = SolarForecastInterval(periodStart: start, periodEnd: start.addingTimeInterval(3600), powerKw: 2)
        let applied = correction.apply(to: [interval], siteTimeZone: Self.chicago, acClipKw: nil)
        #expect(abs(applied[0].powerKw - 1.2) < 1e-9)
    }

    @Test("Applying scales median and cautious power, keeps nil cautious and re-clips")
    func applyScalesAndClips() {
        let correction = Self.derive(Self.samples { _, forecast in forecast * 1.4 })
        let start = Fixture.date("2026-10-29 10:00:00")
        let intervals = [
            SolarForecastInterval(
                periodStart: start,
                periodEnd: start.addingTimeInterval(1800),
                powerKw: 3.5,
                cautiousPowerKw: 2
            ),
            SolarForecastInterval(
                periodStart: start.addingTimeInterval(1800),
                periodEnd: start.addingTimeInterval(3600),
                powerKw: 2
            )
        ]
        let applied = correction.apply(to: intervals, siteTimeZone: Self.chicago, acClipKw: 4)
        #expect(applied[0].powerKw == 4)
        #expect(abs((applied[0].cautiousPowerKw ?? 0) - 2.8) < 1e-9)
        #expect(applied[1].cautiousPowerKw == nil)
        #expect(abs(applied[1].powerKw - 2.8) < 1e-9)
    }

    @Test("Same-day and day-ahead factors apply by lead; longer leads stay raw")
    func cohortSelection() {
        let sameDay = Self.derive(Self.samples { _, forecast in forecast * 0.7 })
        let dayAhead = Self.derive(Self.samples { _, forecast in forecast * 1.3 })
        let cohorts = SolarForecastCohortCorrection(sameDay: sameDay, dayAhead: dayAhead)
        let fetchedAt = Fixture.date("2026-10-29 05:00:00")
        let hours = ["2026-10-29 10:00:00", "2026-10-30 10:00:00", "2026-10-31 10:00:00"].map { Fixture.date($0) }
        let intervals = hours.map { SolarForecastInterval(
            periodStart: $0,
            periodEnd: $0.addingTimeInterval(3600),
            powerKw: 1
        ) }
        let applied = cohorts.apply(to: intervals, fetchedAt: fetchedAt, siteTimeZone: Self.chicago, acClipKw: nil)
        #expect(abs(applied[0].powerKw - 0.7) < 1e-9)
        #expect(abs(applied[1].powerKw - 1.3) < 1e-9)
        #expect(applied[2].powerKw == 1)
        let missingDayAhead = SolarForecastCohortCorrection(sameDay: sameDay, dayAhead: .identity)
        #expect(missingDayAhead.apply(
            to: intervals,
            fetchedAt: fetchedAt,
            siteTimeZone: Self.chicago,
            acClipKw: nil
        )[1].powerKw == 1)
    }

    @Test("Half-hour local offsets train against UTC-hour buckets")
    func kolkataBuckets() async {
        let kolkata = TimeZone(identifier: "Asia/Kolkata") ?? .gmt
        let clock = MutableSolarClock(Fixture.date("2026-10-29 12:00:00", in: kolkata))
        let history = SolarForecastHistory(file: InMemorySolarFile(), clock: clock)
        let identity = SolarForecastHistoryIdentity(
            accountScopeID: "a", siteID: "s", providerID: .solcast, fingerprint: "f"
        )
        let localStart = Fixture.date("2026-10-28 09:00:00", in: kolkata)
        await history.record(
            identity: identity, intervals: Fixture.intervals(from: localStart, hours: 4, powerKw: 2, step: 1800),
            fetchedAt: Fixture.date("2026-10-28 06:00:00", in: kolkata)
        )
        let past = await history.pastForecast(
            identity: identity, cohort: .sameDay, from: localStart, to: localStart.addingTimeInterval(4 * 3600),
            siteTimeZone: kolkata
        )
        // 09:00 IST is 03:30 UTC, so only the three UTC hours fully inside 09:00–13:00 IST count.
        #expect(past.count == 3)
        #expect(past.values.allSatisfy { $0 == 2000 })
        #expect(past.keys.allSatisfy { Int($0.timeIntervalSince1970) % 3600 == 0 })
    }

    @Test("Both repeated fall-back 01:00 hours are separate samples")
    func repeatedHour() {
        let first = Fixture.date("2026-11-01 06:00:00", in: .gmt)
        let second = first.addingTimeInterval(3600)
        let correction = SolarForecastCorrection.derive(
            pastForecastWh: [first: 1000, second: 1000],
            actuals: [first, second].map { MobileSolarActualsHour(hourStart: $0, energyWh: 800, complete: true) },
            siteTimeZone: Self.chicago, now: Fixture.date("2026-11-02 12:00:00")
        )
        #expect(correction.samples == 2)
    }

    @Test("The Solcast decision comes from the offline check")
    func solcastDecision() {
        #expect(SolarForecastCorrection.appliesToSolcast == false)
    }
}
