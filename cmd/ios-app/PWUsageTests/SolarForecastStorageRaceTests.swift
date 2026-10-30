import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Solar forecast storage sign-out fencing")
struct SolarForecastStorageRaceTests {
    @Test("A history record suspended in disk load cannot repopulate a cleared account")
    func historyLoadSignOutRace() async throws {
        let signal = StorageLoadSignal()
        let file = GatedSolarForecastFile<[SolarForecastHistoryEntry]>(initial: []) { signal.started = true }
        let now = SolarProviderFixture.date("2026-10-28 12:00:00")
        let history = SolarForecastHistory(file: file, clock: MutableSolarClock(now))
        let identity = SolarForecastHistoryIdentity(
            accountScopeID: "old-account", siteID: "site-a", providerID: .forecastSolar, fingerprint: "geometry"
        )
        let record = Task {
            await history.record(
                identity: identity,
                intervals: SolarProviderFixture.intervals(from: now, hours: 1, powerKw: 2), fetchedAt: now
            )
        }
        try await eventually { signal.started }
        try await history.clearAccountData()
        await file.resumeLoad()
        await record.value
        #expect(await file.value?.isEmpty == true)
        #expect(await file.saves == 1, "Only the sign-out clear may write after the suspended load")
        #expect(await history.pastForecast(
            identity: identity, cohort: .sameDay, from: now, to: now.addingTimeInterval(3600),
            siteTimeZone: SolarProviderFixture.chicago
        ).isEmpty)
    }

    @Test("A cache store suspended in disk load cannot repopulate a cleared account")
    func cacheLoadSignOutRace() async throws {
        let signal = StorageLoadSignal()
        let file = GatedSolarForecastFile(initial: SolarForecastAutomaticCacheState()) { signal.started = true }
        let cache = SolarForecastAutomaticCache(file: file)
        let now = SolarProviderFixture.date("2026-10-28 12:00:00")
        let batch = SolarForecastRawBatch(
            providerID: .forecastSolar, fingerprint: "geometry", cacheRevision: "revision",
            intervals: SolarProviderFixture.intervals(from: now, hours: 1, powerKw: 2),
            fetchedAt: now, acClipKw: nil
        )
        let store = Task { await cache.store(batch, scope: SolarProviderFixture.scopeA) }
        try await eventually { signal.started }
        try await cache.clearAccountData()
        await file.resumeLoad()
        await store.value
        #expect(await file.value?.entries.isEmpty == true)
        #expect(await file.saves == 1, "Only the sign-out clear may write after the suspended load")
        #expect(await cache.batch(
            scope: SolarProviderFixture.scopeA, providerID: .forecastSolar, cacheRevision: "revision"
        ) == nil)
    }
}

@MainActor
private final class StorageLoadSignal {
    var started = false
}

/// Captures the pre-sign-out snapshot, signals its load, then waits for the test to
/// allow that stale read to return. Saves remain available while load is parked.
private actor GatedSolarForecastFile<Value: Codable & Sendable>: SolarForecastFileStoring {
    private(set) var value: Value?
    private(set) var saves = 0
    private let onLoad: @MainActor @Sendable () -> Void
    private var continuation: CheckedContinuation<Void, Never>?

    init(initial: Value, onLoad: @escaping @MainActor @Sendable () -> Void) {
        value = initial
        self.onLoad = onLoad
    }

    func load() async -> Value? {
        let snapshot = value
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            Task { @MainActor in onLoad() }
        }
        return snapshot
    }

    func save(_ newValue: Value) {
        saves += 1
        value = newValue
    }

    func resumeLoad() {
        continuation?.resume()
        continuation = nil
    }
}
