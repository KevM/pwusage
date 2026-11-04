import Foundation
@testable import PWUsage
import Testing

extension SolarHistoryStoreTests {
    @Test("Hourly aggregation returns UTC hour sums and completeness")
    func hourlyActualsMatchHourlySolarWh() async throws {
        let now = date("2026-10-31T13:00:00Z")
        let start = date("2026-10-31T12:00:00Z")
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "hourly")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let hour = historyDay(day: "2026-10-31", start: start, fetchedAt: now,
                              slots: Array(repeating: 1, count: 288))
        _ = try await store.sync(
            scope: scope,
            api: HistoryAPI(responses: initialResponses(
                .enabled(timeZone: zone("UTC"), days: [hour], nextFrom: nil))), now: now)
        let values = try await store.hourlyActuals(scope: scope, now: now)
        let actualHour = try #require(values.first { $0.hourStart == start })
        #expect(actualHour.energyWh == 12)
        #expect(actualHour.complete)
        let boundaryHour = try #require(values.first { $0.hourStart == date("2026-10-31T13:00:00Z") })
        #expect(boundaryHour.energyWh == 1)
        #expect(!boundaryHour.complete)
    }

    @Test("Hourly aggregation marks missing and negative slots incomplete")
    func hourlyActualsRejectMissingAndNegativeSlots() async throws {
        let now = date("2026-10-31T12:00:00Z")
        let start = date("2026-10-31T11:00:00Z")
        let missingScope = SolarForecastSiteScope(accountScopeID: "a", siteID: "missing")
        let negativeScope = SolarForecastSiteScope(accountScopeID: "a", siteID: "negative")
        let missingStore = SolarHistoryStore(directory: temporaryFolder())
        let negativeStore = SolarHistoryStore(directory: temporaryFolder())
        var missingSlots = [Double?](repeating: 1, count: 288)
        missingSlots[3] = nil
        let missingDay = historyDayWithSlots(day: "2026-10-31", start: start, fetchedAt: now, slots: missingSlots)
        var negativeSlots = [Double?](repeating: 1, count: 288)
        negativeSlots[3] = -1
        let negativeDay = historyDayWithSlots(day: "2026-10-31", start: start, fetchedAt: now, slots: negativeSlots)
        _ = try await missingStore.sync(
            scope: missingScope,
            api: HistoryAPI(responses: initialResponses(
                .enabled(timeZone: zone("UTC"), days: [missingDay], nextFrom: nil))), now: now)
        _ = try await negativeStore.sync(
            scope: negativeScope,
            api: HistoryAPI(responses: initialResponses(
                .enabled(timeZone: zone("UTC"), days: [negativeDay], nextFrom: nil))), now: now)
        let missingHours = try await missingStore.hourlyActuals(scope: missingScope, now: now)
        let negativeHours = try await negativeStore.hourlyActuals(scope: negativeScope, now: now)
        let missingHour = try #require(missingHours.first { $0.hourStart == start })
        let negativeHour = try #require(negativeHours.first { $0.hourStart == start })
        #expect(missingHour.energyWh == 11)
        #expect(!missingHour.complete)
        #expect(negativeHour.energyWh == 11)
        #expect(!negativeHour.complete)
    }

    @Test("All-zero samples form a complete zero-energy hour")
    func zeroSlotsAreValid() async throws {
        let now = date("2026-10-31T12:00:00Z")
        let start = date("2026-10-31T11:00:00Z")
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "zero")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let day = historyDay(day: "2026-10-31", start: start, fetchedAt: now,
                             slots: Array(repeating: 0, count: 288))
        _ = try await store.sync(
            scope: scope,
            api: HistoryAPI(responses: initialResponses(.enabled(timeZone: zone("UTC"), days: [day], nextFrom: nil))),
            now: now)
        let hours = try await store.hourlyActuals(scope: scope, now: now)
        let hour = try #require(hours.first { $0.hourStart == start })
        #expect(hour.energyWh == 0)
        #expect(hour.complete)
    }

    @Test("Fall DST day keeps both repeated local hours as separate UTC hours")
    func fallDSTRetainsRepeatedHours() async throws {
        let now = date("2026-11-01T12:00:00Z")
        let start = date("2026-11-01T07:00:00Z")
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "fall-dst")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let day = historyDay(day: "2026-11-01", start: start, fetchedAt: now,
                             slots: Array(repeating: 1, count: 300))
        _ = try await store.sync(
            scope: scope,
            api: HistoryAPI(responses: initialResponses(
                .enabled(timeZone: zone("America/Los_Angeles"), days: [day], nextFrom: nil),
                timeZone: "America/Los_Angeles")), now: now)
        let hours = try await store.hourlyActuals(scope: scope, now: now)
        let firstOne = try #require(hours.first { $0.hourStart == date("2026-11-01T08:00:00Z") })
        let secondOne = try #require(hours.first { $0.hourStart == date("2026-11-01T09:00:00Z") })
        #expect(firstOne.energyWh == 12)
        #expect(secondOne.energyWh == 12)
        #expect(firstOne.complete && secondOne.complete)
    }

    @Test("Spring DST day retains real UTC five minute timestamps")
    func dstDayUsesRealUTCTimestamps() async throws {
        let now = date("2026-03-08T12:00:00Z")
        let dayStart = date("2026-03-08T08:00:00Z")
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "dst")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let day = historyDay(day: "2026-03-08", start: dayStart, fetchedAt: now,
                             slots: Array(repeating: 1, count: 276))
        _ = try await store.sync(
            scope: scope,
            api: HistoryAPI(responses: initialResponses(
                .enabled(timeZone: zone("America/Los_Angeles"), days: [day], nextFrom: nil),
                timeZone: "America/Los_Angeles")), now: now)
        let samples = try await store.samples(scope: scope)
        #expect(samples.count == 276)
        #expect(samples[12].timestamp == date("2026-03-08T09:00:00Z"))
    }
}
