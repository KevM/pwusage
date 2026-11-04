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
}
