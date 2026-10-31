import Foundation
@testable import PWUsage
import Testing

@Suite("Solar History Store")
struct SolarHistoryStoreTests {
    @Test("Pages use the same watermark and apply the five minute lag")
    func pagesUseStableWatermarkAndLag() async throws {
        let fetchedAt = Date(timeIntervalSince1970: 1_800_000_000)
        let first = response(day: fetchedAt, nextFrom: "2026-01-02")
        let second = response(day: fetchedAt.addingTimeInterval(60), nextFrom: nil)
        let empty = MobileSolarHistoryResponse.enabled(timeZone: zone("UTC"), days: [], nextFrom: nil)
        let api = HistoryAPI(responses: [empty, first, second, empty])
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = SolarHistoryStore(directory: folder)
        let scope = SolarForecastSiteScope(accountScopeID: "account", siteID: "site")
        _ = try await store.sync(scope: scope, api: api, now: fetchedAt)
        let initialRequests = await api.requests
        let storedSamples = try await store.samples(scope: scope)
        #expect(initialRequests.map(\.changedSince) == [nil, nil, nil])
        #expect(storedSamples.count == 288)
        _ = try await store.sync(scope: scope, api: api, now: fetchedAt)
        let requests = await api.requests
        #expect(requests.map(\.changedSince) == [nil, nil, nil, fetchedAt.addingTimeInterval(-240)])
        try await store.removeAll()
    }

    @Test("First request begins 365 days before now")
    func firstRequestStarts365DaysBack() async throws {
        let now = ISO8601DateFormatter().date(from: "2026-10-31T12:00:00Z") ?? .now
        let api = HistoryAPI(responses: [.enabled(timeZone: zone("UTC"), days: [], nextFrom: nil), .disabled])
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = SolarHistoryStore(directory: folder)
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "s")
        _ = try await store.sync(scope: scope, api: api, now: now)
        let requests = await api.requests
        #expect(requests.map(\.from) == ["2025-11-01", "2025-10-31"])
    }

    @Test("First sync restarts at the exact site-local 365-day boundary")
    func firstSyncCorrectsBootstrapUsingSiteTimeZone() async throws {
        let now = date("2026-10-31T05:00:00Z")
        let empty = MobileSolarHistoryResponse.enabled(timeZone: zone("America/Los_Angeles"), days: [], nextFrom: nil)
        let api = HistoryAPI(responses: [empty, empty])
        let store = SolarHistoryStore(directory: temporaryFolder())
        _ = try await store.sync(
            scope: SolarForecastSiteScope(accountScopeID: "a", siteID: "zone"), api: api, now: now)
        let requests = await api.requests
        #expect(requests.map(\.from) == ["2025-11-01", "2025-10-30"])
        #expect(requests.allSatisfy { $0.changedSince == nil })
    }

    @Test("Empty first sync keeps the learned site zone for a local-boundary retry")
    func emptyFirstSyncRetryUsesKnownZone() async throws {
        let now = date("2026-10-31T05:00:00Z")
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "empty-zone")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let empty = MobileSolarHistoryResponse.enabled(timeZone: zone("America/Los_Angeles"), days: [], nextFrom: nil)
        let initial = HistoryAPI(responses: [empty, empty])
        _ = try await store.sync(scope: scope, api: initial, now: now)
        let retry = HistoryAPI(responses: [.enabled(timeZone: zone("America/Los_Angeles"), days: [], nextFrom: nil)])
        _ = try await store.sync(scope: scope, api: retry, now: now)
        let requests = await retry.requests
        #expect(requests.map(\.from) == ["2025-10-30"])
        #expect(requests.allSatisfy { $0.changedSince == nil })
    }

    @Test("Interrupted paging retries the first sync without a watermark")
    func interruptedFirstSyncRetriesWithoutWatermark() async throws {
        let now = date("2026-10-31T12:00:00Z")
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "retry")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let empty = MobileSolarHistoryResponse.enabled(timeZone: zone("UTC"), days: [], nextFrom: nil)
        let interrupted = HistoryAPI(responses: [empty, response(day: now, nextFrom: "2026-01-02")], failAt: 3)
        await #expect(throws: HistoryFailure.self) {
            try await store.sync(scope: scope, api: interrupted, now: now)
        }
        let retry = HistoryAPI(responses: [empty, empty])
        _ = try await store.sync(scope: scope, api: retry, now: now)
        let requests = await retry.requests
        #expect(requests.map(\.changedSince) == [nil, nil])
        #expect(requests.map(\.from) == ["2025-11-01", "2025-10-31"])
    }

    @Test("Incremental rewrites replace a day by dayStart")
    func incrementalRewriteUsesDayStartIdentity() async throws {
        let now = date("2026-10-31T12:00:00Z")
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "rewrite")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let firstDay = historyDay(day: "2025-09-26", start: date("2025-09-26T00:00:00Z"),
                                  fetchedAt: now, slots: Array(repeating: 1, count: 288))
        _ = try await store.sync(
            scope: scope,
            api: HistoryAPI(responses: initialResponses(
                .enabled(timeZone: zone("UTC"), days: [firstDay], nextFrom: nil))), now: now)
        let rewrite = historyDay(day: "label-is-not-the-key", start: firstDay.dayStart,
                                 fetchedAt: now.addingTimeInterval(600), slots: Array(repeating: 2, count: 288))
        let incremental = HistoryAPI(responses: [.enabled(timeZone: zone("UTC"), days: [rewrite], nextFrom: nil)])
        _ = try await store.sync(scope: scope, api: incremental, now: now)
        let samples = try await store.samples(scope: scope)
        let requests = await incremental.requests
        #expect(samples.count == 288)
        #expect(samples.allSatisfy { $0.solarWh == 2 })
        #expect(requests.first?.changedSince == now.addingTimeInterval(-300))
        #expect(requests.first?.from == "2025-09-26")
    }

    @Test("Incremental boundary remains valid when server has crossed midnight")
    func incrementalBoundaryAllowsOneDayClockSkew() async throws {
        let now = date("2026-10-31T23:59:59Z")
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "clock-skew")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let day = historyDay(day: "2026-10-31", start: date("2026-10-31T00:00:00Z"),
                             fetchedAt: now, slots: [1])
        _ = try await store.sync(scope: scope, api: HistoryAPI(responses: initialResponses(
            .enabled(timeZone: zone("UTC"), days: [day], nextFrom: nil))), now: now)
        let api = HistoryAPI(
            responses: [.enabled(timeZone: zone("UTC"), days: [], nextFrom: nil)], failAt: 1,
            failure: PWUsageAPIError.requestRejected(statusCode: 400, message: nil))
        _ = try await store.sync(scope: scope, api: api, now: now)
        let requests = await api.requests
        #expect(requests.map(\.from) == ["2025-09-26", "2025-09-27"])
        #expect(requests.map(\.changedSince) == [now.addingTimeInterval(-300), now.addingTimeInterval(-300)])
    }

    @Test("Multi-page incremental sync keeps its starting watermark until completion")
    func incrementalPagesCommitWatermarkOnlyAtEnd() async throws {
        let now = date("2026-10-31T12:00:00Z")
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "multi-page")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let firstStart = date("2026-10-30T00:00:00Z")
        let firstFetch = now.addingTimeInterval(-600)
        let original = historyDay(day: "2026-10-30", start: firstStart, fetchedAt: firstFetch,
                                  slots: Array(repeating: 1, count: 288))
        _ = try await store.sync(
            scope: scope, api: HistoryAPI(responses: initialResponses(
                .enabled(timeZone: zone("UTC"), days: [original], nextFrom: nil))), now: now)
        let oldWatermark = firstFetch.addingTimeInterval(-300)
        let rewritten = historyDay(day: "2026-10-30", start: firstStart,
                                   fetchedAt: now.addingTimeInterval(120), slots: Array(repeating: 2, count: 288))
        let firstPage = MobileSolarHistoryResponse.enabled(
            timeZone: zone("UTC"), days: [rewritten], nextFrom: "2026-10-31")
        let interrupted = HistoryAPI(responses: [firstPage], failAt: 2)
        await #expect(throws: HistoryFailure.self) {
            try await store.sync(scope: scope, api: interrupted, now: now)
        }
        let unchangedSamples = try await store.samples(scope: scope)
        #expect(unchangedSamples.allSatisfy { $0.solarWh == 1 })
        let secondStart = date("2026-10-31T00:00:00Z")
        let latestFetch = now.addingTimeInterval(600)
        let newDay = historyDay(day: "2026-10-31", start: secondStart, fetchedAt: latestFetch,
                                slots: Array(repeating: 3, count: 288))
        let lastPage = MobileSolarHistoryResponse.enabled(timeZone: zone("UTC"), days: [newDay], nextFrom: nil)
        let completed = HistoryAPI(responses: [firstPage, lastPage])
        _ = try await store.sync(scope: scope, api: completed, now: now)
        let requests = await completed.requests
        #expect(requests.map(\.changedSince) == [oldWatermark, oldWatermark])
        #expect(requests.map(\.from) == ["2025-09-26", "2026-10-31"])
        let completedSamples = try await store.samples(scope: scope)
        #expect(completedSamples.filter { $0.solarWh == 2 }.count == 288)
        let nextSync = HistoryAPI(responses: [.enabled(timeZone: zone("UTC"), days: [], nextFrom: nil)])
        _ = try await store.sync(scope: scope, api: nextSync, now: now)
        let nextRequest = await nextSync.requests.first
        #expect(nextRequest?.changedSince == latestFetch.addingTimeInterval(-300))
    }

    @Test("Prunes days older than 400 calendar days")
    func prunesDay401() async throws {
        let now = date("2026-10-31T12:00:00Z")
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "prune")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let old = historyDay(day: "2025-09-25", start: date("2025-09-25T00:00:00Z"),
                             fetchedAt: now, slots: Array(repeating: 0, count: 288))
        let recent = historyDay(day: "2026-10-31", start: date("2026-10-31T00:00:00Z"),
                                fetchedAt: now, slots: Array(repeating: 1, count: 288))
        _ = try await store.sync(
            scope: scope,
            api: HistoryAPI(responses: initialResponses(
                .enabled(timeZone: zone("UTC"), days: [old, recent], nextFrom: nil))), now: now)
        #expect(try await store.lastDay(scope: scope) == "2026-10-31")
        #expect(try await store.samples(scope: scope).count == 288)
    }

    @Test("Disabled response removes the persisted account history")
    func disabledRemovesHistory() async throws {
        let now = date("2026-10-31T12:00:00Z")
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "disabled")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let day = historyDay(day: "2026-10-31", start: date("2026-10-31T00:00:00Z"),
                             fetchedAt: now, slots: Array(repeating: 1, count: 288))
        _ = try await store.sync(
            scope: scope,
            api: HistoryAPI(responses: initialResponses(
                .enabled(timeZone: zone("UTC"), days: [day], nextFrom: nil))), now: now)
        #expect(try await store.samples(scope: scope).count == 288)
        #expect(try await store.sync(scope: scope, api: HistoryAPI(responses: [.disabled]), now: now) == .disabled)
        #expect(try await store.samples(scope: scope).isEmpty)
    }
}

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

    @Test("Sign out removes all persisted files")
    func signOutRemovesFiles() async throws {
        let now = date("2026-10-31T12:00:00Z")
        let folder = temporaryFolder()
        let store = SolarHistoryStore(directory: folder)
        let day = historyDay(day: "2026-10-31", start: date("2026-10-31T00:00:00Z"),
                             fetchedAt: now, slots: Array(repeating: 1, count: 288))
        _ = try await store.sync(
            scope: SolarForecastSiteScope(accountScopeID: "a", siteID: "signout"),
            api: HistoryAPI(responses: initialResponses(
                .enabled(timeZone: zone("UTC"), days: [day], nextFrom: nil))), now: now)
        try await store.removeAll()
        #expect(!FileManager.default.fileExists(atPath: folder.path))
    }

    @Test("Sign out prevents an in-flight sync from restoring removed history")
    @MainActor
    func signOutInvalidatesInFlightSync() async throws {
        let now = date("2026-10-31T12:00:00Z")
        let folder = temporaryFolder()
        let store = SolarHistoryStore(directory: folder)
        let api = SuspendedHistoryAPI()
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "in-flight")
        let layoutFolder = temporaryFolder()
        let layoutStore = SolarLayoutRecordStore(directory: layoutFolder)
        try await layoutStore.setLocation(
            SolarHomeLocation(latitude: 43, longitude: -87, source: .device), scope: scope)
        let day = historyDay(day: "2026-10-31", start: date("2026-10-31T00:00:00Z"),
                             fetchedAt: now, slots: Array(repeating: 1, count: 288))
        _ = try await store.sync(scope: scope, api: HistoryAPI(responses: initialResponses(
            .enabled(timeZone: zone("UTC"), days: [day], nextFrom: nil))), now: now)
        #expect(FileManager.default.fileExists(atPath: folder.path))
        let sync = Task { try await store.sync(scope: scope, api: api, now: now) }
        await api.waitUntilRequested()
        let cleanup = SolarForecastStoreSessionCleanup(
            store: FakeSolcastStore(), historyStore: store, layoutRecordStore: layoutStore)
        let configuration = try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true)
        let auth = MobileAuthService(configuration: configuration, forecastCleanup: cleanup)
        try await auth.invalidateAuthenticatedSession()
        await api.resume(with: .enabled(timeZone: zone("UTC"), days: [], nextFrom: nil))
        await #expect(throws: CancellationError.self) { try await sync.value }
        #expect(!FileManager.default.fileExists(atPath: folder.path))
        #expect(!FileManager.default.fileExists(atPath: layoutFolder.path))
    }
    private func response(day fetchedAt: Date, nextFrom: String?) -> MobileSolarHistoryResponse {
        let start = ISO8601DateFormatter().date(from: "2026-01-01T00:00:00Z") ?? .distantPast
        let data = MobileSolarHistoryDay(
            day: "2026-01-01", dayStart: start, status: .complete, fetchedAt: fetchedAt,
            solarWh: Array(repeating: 1, count: 288).map(Optional.some))
        return .enabled(timeZone: zone("UTC"), days: [data], nextFrom: nextFrom)
    }
    private func historyDay(day: String, start: Date, fetchedAt: Date, slots: [Double]) -> MobileSolarHistoryDay {
        MobileSolarHistoryDay(day: day, dayStart: start, status: .complete, fetchedAt: fetchedAt,
                              solarWh: slots.map(Optional.some))
    }
    private func historyDayWithSlots(
        day: String,
        start: Date,
        fetchedAt: Date,
        slots: [Double?]
    ) -> MobileSolarHistoryDay {
        MobileSolarHistoryDay(day: day, dayStart: start, status: .complete, fetchedAt: fetchedAt, solarWh: slots)
    }
    private func date(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value) ?? .distantPast
    }
    private func initialResponses(
        _ response: MobileSolarHistoryResponse,
        timeZone: String = "UTC"
    ) -> [MobileSolarHistoryResponse] {
        [.enabled(timeZone: zone(timeZone), days: [], nextFrom: nil), response]
    }
    private func temporaryFolder() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }
    private func zone(_ identifier: String) -> TimeZone {
        TimeZone(identifier: identifier) ?? .gmt
    }
}
