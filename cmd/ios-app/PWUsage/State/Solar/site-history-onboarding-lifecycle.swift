import Foundation

/// When the onboarding job runs. In the foreground it works through the selected site, waiting
/// out backoffs and throttles in place; leaving the foreground cancels it (confirmed progress is
/// already saved) and asks iOS for a background opportunity from the saved state. iOS may never
/// grant one, so every foreground activation picks the job up again.
@MainActor
final class SiteHistoryOnboardingLifecycle {
    typealias Sleep = @MainActor (TimeInterval) async throws -> Void

    /// Slices per background opportunity (about two months); expiration may end it sooner.
    static let backgroundSlices = 20

    private let onboarding: SiteHistoryOnboarding
    private let store: SiteHistoryOnboardingStore
    /// Whether the site has the solar history beta; may sync history to find out.
    private let isHistoryEnabled: @MainActor (SolarForecastSiteScope) async -> Bool
    private let scheduleBackground: @MainActor (Date?) -> Void
    private let sleep: Sleep
    private let now: () -> Date
    private struct ForegroundRun {
        let scope: SolarForecastSiteScope
        let id: UUID
        let task: Task<Void, Never>
    }

    private var foreground: ForegroundRun?
    /// The scope the next background opportunity is for.
    private(set) var lastScope: SolarForecastSiteScope?

    init(
        onboarding: SiteHistoryOnboarding,
        store: SiteHistoryOnboardingStore = .shared,
        isHistoryEnabled: @escaping @MainActor (SolarForecastSiteScope) async -> Bool,
        scheduleBackground: @escaping @MainActor (Date?) -> Void,
        sleep: @escaping Sleep = { try await Task.sleep(for: .seconds($0)) },
        now: @escaping () -> Date = Date.init
    ) {
        self.onboarding = onboarding
        self.store = store
        self.isHistoryEnabled = isHistoryEnabled
        self.scheduleBackground = scheduleBackground
        self.sleep = sleep
        self.now = now
    }

    /// The foreground run in progress, for tests to await.
    var foregroundTask: Task<Void, Never>? { foreground?.task }

    /// Run `scope` in the foreground, replacing work for any other scope. Joins a run already
    /// in progress for the same scope.
    func activate(scope: SolarForecastSiteScope) {
        lastScope = scope
        if foreground?.scope == scope { return }
        foreground?.task.cancel()
        // The task clears the slot only while it still owns it, so a newer run is never dropped.
        let id = UUID()
        let task = Task { [weak self] in
            await self?.runForeground(scope)
            if let self, foreground?.id == id { foreground = nil }
        }
        foreground = ForegroundRun(scope: scope, id: id, task: task)
    }

    /// Leaving the foreground: stop, and offer iOS the next opportunity for the last scope.
    func deactivate() async {
        foreground?.task.cancel()
        foreground = nil
        guard let lastScope else { return }
        let next = await nextOpportunity(scope: lastScope)
        // Activated again while the saved state was read: the foreground owns the job.
        guard foreground == nil else { return }
        scheduleBackground(next)
    }

    /// Sign-out or a lost session: no work, and no background request, for anyone.
    func stop() {
        foreground?.task.cancel()
        foreground = nil
        lastScope = nil
        scheduleBackground(nil)
    }

    /// After the action a pause asked for (reconnecting Tesla, signing in) succeeds.
    func resumePaused(accountScopeID: String, reason: SiteHistoryOnboarding.PauseReason) async {
        try? await store.resumePaused(accountScopeID: accountScopeID, reason: reason)
    }

    /// One background opportunity: a bounded run, then when to ask for the next one.
    func runInBackground(scope: SolarForecastSiteScope, maxSlices: Int = backgroundSlices) async -> Date? {
        lastScope = scope
        guard await prepare(scope) else { return nil }
        _ = await onboarding.run(scope: scope, maxSlices: maxSlices)
        return await nextOpportunity(scope: scope)
    }

    /// The earliest the job could make progress, from the saved state alone: nil once it is
    /// paused or finished, otherwise the later of now, its backoff and the account's throttle.
    func nextOpportunity(scope: SolarForecastSiteScope) async -> Date? {
        let progress = try? await store.progress(scope: scope)
        if let phase = progress?.phase, phase != .active { return nil }
        let throttle = try? await store.throttle(accountScopeID: scope.accountScopeID)
        return [now(), throttle, progress?.nextAttemptAt].compactMap(\.self).max()
    }

    private func runForeground(_ scope: SolarForecastSiteScope) async {
        while !Task.isCancelled {
            guard await prepare(scope) else { return }
            guard case .waiting(let until, _) = await onboarding.run(scope: scope) else { return }
            do { try await sleep(max(until.timeIntervalSince(now()), 0)) } catch { return }
        }
    }

    /// Only sites with the history beta run. One that finished because history was unavailable is
    /// reopened once history is enabled again.
    private func prepare(_ scope: SolarForecastSiteScope) async -> Bool {
        guard await isHistoryEnabled(scope), !Task.isCancelled else { return false }
        if case .finished(.historyUnavailable)? = (try? await store.progress(scope: scope))?.phase {
            try? await store.resume(scope: scope)
        }
        return !Task.isCancelled
    }
}

extension SiteHistoryOnboardingLifecycle {
    /// The app's lifecycle over the shared stores, the layout runner and `api`.
    static func live(
        api: any MobileSolarHistoryFillAPI, runner: SolarLayoutDetectionRunner,
        history: SolarHistoryStore = .shared, records: SolarLayoutRecordStore = .shared
    ) -> SiteHistoryOnboardingLifecycle {
        let environment = LiveSiteHistoryOnboardingEnvironment(
            api: api, history: history, records: records, runner: runner)
        return SiteHistoryOnboardingLifecycle(
            onboarding: SiteHistoryOnboarding(environment: environment),
            isHistoryEnabled: { await environment.isHistoryEnabled(scope: $0) },
            scheduleBackground: { BackgroundSiteHistoryOnboarding.schedule(earliest: $0) }
        )
    }
}
