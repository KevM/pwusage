import Foundation
@testable import PWUsage
import Testing

extension SolarHistoryStoreTests {
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
        let cleanup = SolarSessionCleanup(historyStore: store, layoutRecordStore: layoutStore)
        let configuration = try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true)
        let auth = MobileAuthService(configuration: configuration, forecastCleanup: cleanup)
        try await auth.invalidateAuthenticatedSession()
        await api.resume(with: .enabled(timeZone: zone("UTC"), days: [], nextFrom: nil))
        await #expect(throws: CancellationError.self) { try await sync.value }
        #expect(!FileManager.default.fileExists(atPath: folder.path))
        #expect(!FileManager.default.fileExists(atPath: layoutFolder.path))
    }

    @Test("remove(scope:) wakes all queued sync waiters with CancellationError")
    func removeScopeWakesAllQueuedWaiters() async throws {
        let now = date("2026-10-31T12:00:00Z")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let api = SuspendedHistoryAPI()
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "queued-remove")
        let active = Task { try await store.sync(scope: scope, api: api, now: now) }
        await api.waitUntilRequested()

        let emptyPage = MobileSolarHistoryResponse.enabled(timeZone: zone("UTC"), days: [], nextFrom: nil)
        let waiterOne = Task {
            try await store.sync(scope: scope, api: HistoryAPI(responses: initialResponses(emptyPage)), now: now)
        }
        let waiterTwo = Task {
            try await store.sync(scope: scope, api: HistoryAPI(responses: initialResponses(emptyPage)), now: now)
        }
        try await waitForWaiterCount(2, in: store, scope: scope)

        try await store.remove(scope: scope)
        await #expect(throws: CancellationError.self) { try await waiterOne.value }
        await #expect(throws: CancellationError.self) { try await waiterTwo.value }

        await api.resume(with: emptyPage)
        await #expect(throws: CancellationError.self) { try await active.value }
    }

    @Test("Cancelling the first queued waiter still wakes the next waiter")
    func cancelledFirstWaiterWakesSecondWaiter() async throws {
        let now = date("2026-10-31T12:00:00Z")
        let store = SolarHistoryStore(directory: temporaryFolder())
        let api = SuspendedHistoryAPI()
        let scope = SolarForecastSiteScope(accountScopeID: "a", siteID: "queued-cancel")
        let active = Task { try await store.sync(scope: scope, api: api, now: now) }
        await api.waitUntilRequested()

        let emptyPage = MobileSolarHistoryResponse.enabled(timeZone: zone("UTC"), days: [], nextFrom: nil)
        let waiterOne = Task {
            try await store.sync(scope: scope, api: HistoryAPI(responses: initialResponses(emptyPage)), now: now)
        }
        let waiterTwo = Task {
            try await store.sync(scope: scope, api: HistoryAPI(responses: initialResponses(emptyPage)), now: now)
        }
        try await waitForWaiterCount(2, in: store, scope: scope)

        waiterOne.cancel()
        await api.resume(with: emptyPage)

        _ = try await active.value
        await #expect(throws: CancellationError.self) { try await waiterOne.value }
        let secondResult = try await waiterTwo.value
        #expect(secondResult == .synced(timeZone: zone("UTC")))
    }

    private func waitForWaiterCount(
        _ expected: Int,
        in store: SolarHistoryStore,
        scope: SolarForecastSiteScope
    ) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while await store.syncWaiters[scope]?.count != expected {
            try #require(ContinuousClock.now < deadline)
            try await Task.sleep(for: .milliseconds(5))
        }
    }
}
