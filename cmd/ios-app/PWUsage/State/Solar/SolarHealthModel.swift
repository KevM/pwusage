import Foundation
import Observation

/// Runs the on-device solar health pass for the active site, classifies findings and tracks
/// whether the user has seen new findings on the Solar System screen.
@MainActor
@Observable
final class SolarHealthModel {
    private static let seenKeyPrefix = "solarHealthSeenFindings."

    typealias PassRunner = @Sendable (
        SolarForecastSiteScope, SolarHistoryStore, SolarLayoutRecord, SolarHealthCache, Date
    ) async throws -> SolarHealthResult?

    private let history: SolarHistoryStore
    private let records: SolarLayoutRecordStore
    private let cache: SolarHealthCache
    private let defaults: UserDefaults
    private let runner: PassRunner
    private let now: () -> Date

    @ObservationIgnored private var runTask: Task<Void, Never>?
    private(set) var scope: SolarForecastSiteScope?
    private(set) var report: SolarHealthReport?
    private(set) var isRunning = false
    private(set) var hasUnreadFinding = false

    init(
        history: SolarHistoryStore = .shared,
        records: SolarLayoutRecordStore = .shared,
        cache: SolarHealthCache = SolarHealthCache(),
        defaults: UserDefaults = .standard,
        runner: @escaping PassRunner = { scope, history, record, cache, now in
            try await SolarHealthPass.run(
                scope: scope, history: history, record: record, cache: cache, now: now)
        },
        now: @escaping () -> Date = Date.init
    ) {
        self.history = history
        self.records = records
        self.cache = cache
        self.defaults = defaults
        self.runner = runner
        self.now = now
    }

    func activate(scope next: SolarForecastSiteScope) {
        if scope == next {
            if runTask == nil { reload() }
            return
        }
        runTask?.cancel()
        runTask = nil
        scope = next
        report = nil
        hasUnreadFinding = false
        reload()
    }

    func reload() {
        guard let scope else { return }
        runTask?.cancel()
        isRunning = true
        runTask = Task { [weak self] in
            await self?.perform(scope: scope)
        }
    }

    func markFindingsSeen() {
        guard let scope, let report else { return }
        let ids = report.visibleFindings.map(\.id)
        defaults.set(ids, forKey: Self.seenKeyPrefix + scope.storageHash)
        hasUnreadFinding = false
    }

    func end() {
        runTask?.cancel()
        runTask = nil
        scope = nil
        report = nil
        isRunning = false
        hasUnreadFinding = false
    }

    func forget(scope target: SolarForecastSiteScope) async {
        if scope == target { end() }
        try? cache.remove(scope: target)
        defaults.removeObject(forKey: Self.seenKeyPrefix + target.storageHash)
    }

    private func perform(scope target: SolarForecastSiteScope) async {
        defer {
            if scope == target {
                isRunning = false
                runTask = nil
            }
        }
        guard let record = try? await records.record(scope: target),
              let result = try? await runner(target, history, record, cache, now()),
              !Task.isCancelled, scope == target else {
            return
        }
        let classified = SolarHealthClassifier.classify(result, manual: record.manualLayout, now: now())
        report = classified
        let seen = Set(defaults.stringArray(forKey: Self.seenKeyPrefix + target.storageHash) ?? [])
        hasUnreadFinding = classified.visibleFindings.contains { !seen.contains($0.id) }
    }
}
