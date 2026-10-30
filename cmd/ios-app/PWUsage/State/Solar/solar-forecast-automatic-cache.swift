import Foundation

struct SolarForecastAutomaticCacheState: Codable, Equatable, Sendable {
    struct Entry: Codable, Equatable, Sendable {
        let scope: SolarForecastSiteScope
        let batch: SolarForecastRawBatch
    }

    var entries: [Entry] = []
}

/// Raw batches for automatic providers, keyed by site, provider and cache revision. Shared by
/// every automatic adapter; each keeps its own transport and quota rules.
actor SolarForecastAutomaticCache {
    static let shared = SolarForecastAutomaticCache(
        file: ProtectedSolarForecastFile(name: "automatic.json", backgroundAccessible: true)
    )

    private let file: any SolarForecastFileStoring<SolarForecastAutomaticCacheState>
    private var state = SolarForecastAutomaticCacheState()
    private var loaded = false
    private var generation = 0

    init(file: any SolarForecastFileStoring<SolarForecastAutomaticCacheState>) {
        self.file = file
    }

    func batch(
        scope: SolarForecastSiteScope,
        providerID: SolarForecastProviderID,
        cacheRevision: String
    ) async -> SolarForecastRawBatch? {
        let started = generation
        await loadIfNeeded()
        guard started == generation else { return nil }
        return state.entries.first {
            $0.scope == scope && $0.batch.providerID == providerID && $0.batch.cacheRevision == cacheRevision
        }?.batch
    }

    /// Replaces the site's batch from this provider. A failed write keeps it in memory.
    func store(_ batch: SolarForecastRawBatch, scope: SolarForecastSiteScope) async {
        let started = generation
        await loadIfNeeded()
        guard started == generation else { return }
        state.entries.removeAll { $0.scope == scope && $0.batch.providerID == batch.providerID }
        state.entries.append(.init(scope: scope, batch: batch))
        try? await file.save(state)
    }

    func clearAccountData() async throws {
        // Invalidate callers suspended in load before they can append or save old data.
        generation += 1
        loaded = true
        state.entries.removeAll()
        try await file.save(state)
    }

    private func loadIfNeeded() async {
        guard !loaded else { return }
        let started = generation
        let saved = try? await file.load()
        guard started == generation, !loaded else { return }
        loaded = true
        state.entries = (saved?.entries ?? []) + state.entries
    }
}
