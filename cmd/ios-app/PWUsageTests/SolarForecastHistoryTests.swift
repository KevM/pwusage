import Foundation
@testable import PWUsage
import Testing

@Suite("Solar forecast raw history")
struct SolarForecastHistoryTests {
    private typealias Fixture = SolarProviderFixture
    private static let identity = SolarForecastHistoryIdentity(
        accountScopeID: "account-a", siteID: "site-a", providerID: .forecastSolar, fingerprint: "geometry-1"
    )

    private static func history(
        now: Date,
        file: InMemorySolarFile<[SolarForecastHistoryEntry]> = InMemorySolarFile()
    ) -> (SolarForecastHistory, MutableSolarClock) {
        let clock = MutableSolarClock(now)
        return (SolarForecastHistory(file: file, clock: clock), clock)
    }

    private static func hour(_ text: String) -> Date { Fixture.date(text) }

    @Test("Same-day training uses the latest capture before the hour; day-ahead uses the previous local day")
    func cohorts() async {
        let (history, _) = Self.history(now: Self.hour("2026-10-29 12:00:00"))
        let start = Self.hour("2026-10-28 00:00:00")
        for (fetched, power) in [("2026-10-27 18:00:00", 1.0), ("2026-10-28 05:30:00", 2.0), (
            "2026-10-28 10:00:00",
            3.0
        )] {
            await history.record(
                identity: Self.identity, intervals: Fixture.intervals(from: start, hours: 24, powerKw: power),
                fetchedAt: Self.hour(fetched)
            )
        }
        let nine = Self.hour("2026-10-28 09:00:00")
        let eleven = Self.hour("2026-10-28 11:00:00")
        let sameDay = await history.pastForecast(
            identity: Self.identity, cohort: .sameDay, from: nine, to: eleven.addingTimeInterval(3600),
            siteTimeZone: Fixture.chicago
        )
        #expect(sameDay[nine] == 2000)
        #expect(sameDay[eleven] == 3000)
        let dayAhead = await history.pastForecast(
            identity: Self.identity, cohort: .dayAhead, from: nine, to: eleven.addingTimeInterval(3600),
            siteTimeZone: Fixture.chicago
        )
        #expect(dayAhead[nine] == 1000)
        #expect(dayAhead[eleven] == 1000)
    }

    @Test("Another configuration's history is never used, and missing cohorts stay empty")
    func isolation() async {
        let (history, _) = Self.history(now: Self.hour("2026-10-29 12:00:00"))
        let start = Self.hour("2026-10-28 00:00:00")
        await history.record(
            identity: Self.identity, intervals: Fixture.intervals(from: start, hours: 24, powerKw: 1),
            fetchedAt: Self.hour("2026-10-28 05:00:00")
        )
        let other = SolarForecastHistoryIdentity(
            accountScopeID: "account-a", siteID: "site-a", providerID: .forecastSolar, fingerprint: "geometry-2"
        )
        let from = Self.hour("2026-10-28 08:00:00")
        let end = Self.hour("2026-10-28 12:00:00")
        #expect(await history.pastForecast(
            identity: other, cohort: .sameDay, from: from, to: end, siteTimeZone: Fixture.chicago
        ).isEmpty)
        #expect(await history.pastForecast(
            identity: Self.identity, cohort: .dayAhead, from: from, to: end, siteTimeZone: Fixture.chicago
        ).isEmpty)
    }

    @Test("Half-hour intervals integrate to UTC-hour energy; partly covered hours are dropped")
    func integration() async {
        let utc = TimeZone.gmt
        let (history, _) = Self.history(now: Fixture.date("2026-10-29 12:00:00", in: utc))
        let start = Fixture.date("2026-10-28 23:30:00", in: utc)
        await history.record(
            identity: Self.identity, intervals: Fixture.intervals(from: start, hours: 2, powerKw: 2, step: 1800),
            fetchedAt: Fixture.date("2026-10-28 20:00:00", in: utc)
        )
        let past = await history.pastForecast(
            identity: Self.identity, cohort: .dayAhead, from: Fixture.date("2026-10-28 22:00:00", in: utc),
            to: Fixture.date("2026-10-29 03:00:00", in: utc), siteTimeZone: utc
        )
        #expect(past == [Fixture.date("2026-10-29 00:00:00", in: utc): 2000])
    }

    @Test("Repeated fall-back hours are separate UTC samples")
    func fallBack() async {
        let (history, _) = Self.history(now: Self.hour("2026-11-02 12:00:00"))
        let midnight = Self.hour("2026-11-01 00:00:00")
        await history.record(
            identity: Self.identity, intervals: Fixture.intervals(from: midnight, hours: 25, powerKw: 1),
            fetchedAt: Self.hour("2026-10-31 20:00:00")
        )
        let past = await history.pastForecast(
            identity: Self.identity, cohort: .dayAhead, from: midnight, to: midnight.addingTimeInterval(25 * 3600),
            siteTimeZone: Fixture.chicago
        )
        #expect(past.count == 25)
    }

    @Test("Recording is idempotent per fetch, entries expire after 15 days and survive relaunch")
    func dedupeExpiryPersistence() async {
        let file = InMemorySolarFile<[SolarForecastHistoryEntry]>()
        let (history, clock) = Self.history(now: Self.hour("2026-10-28 12:00:00"), file: file)
        let start = Self.hour("2026-10-28 00:00:00")
        let fetched = Self.hour("2026-10-28 05:00:00")
        for _ in 0 ..< 2 {
            await history.record(
                identity: Self.identity, intervals: Fixture.intervals(from: start, hours: 24, powerKw: 1),
                fetchedAt: fetched
            )
        }
        #expect(await file.value?.count == 1)
        let reloaded = SolarForecastHistory(file: file, clock: clock)
        let nine = Self.hour("2026-10-28 09:00:00")
        #expect(await reloaded.pastForecast(
            identity: Self.identity, cohort: .sameDay, from: nine, to: nine.addingTimeInterval(3600),
            siteTimeZone: Fixture.chicago
        )[nine] == 1000)
        clock.advance(by: 16 * 86400)
        #expect(await reloaded.pastForecast(
            identity: Self.identity, cohort: .sameDay, from: nine, to: nine.addingTimeInterval(3600),
            siteTimeZone: Fixture.chicago
        ).isEmpty)
    }

    @Test("Sign-out clears history, and a failed write never throws to the caller")
    func clearingAndFailures() async throws {
        let file = InMemorySolarFile<[SolarForecastHistoryEntry]>()
        let (history, _) = Self.history(now: Self.hour("2026-10-28 12:00:00"), file: file)
        await file.setFailingSaves(true)
        await history.record(
            identity: Self.identity, intervals: Fixture.intervals(
                from: Self.hour("2026-10-28 00:00:00"),
                hours: 24,
                powerKw: 1
            ),
            fetchedAt: Self.hour("2026-10-28 05:00:00")
        )
        await file.setFailingSaves(false)
        try await history.clearAccountData()
        let nine = Self.hour("2026-10-28 09:00:00")
        #expect(await history.pastForecast(
            identity: Self.identity, cohort: .sameDay, from: nine, to: nine.addingTimeInterval(3600),
            siteTimeZone: Fixture.chicago
        ).isEmpty)
        #expect(await file.value?.isEmpty == true)
    }
}
