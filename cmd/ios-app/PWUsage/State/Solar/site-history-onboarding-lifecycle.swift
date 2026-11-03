import Foundation
import Observation

/// When the onboarding job runs. In the foreground it works through the selected site, waiting
/// out backoffs and throttles in place; leaving the foreground cancels it (confirmed progress is
/// already saved) and asks iOS for a background opportunity from the saved state. iOS may never
/// grant one, so every foreground activation picks the job up again. `status` is the saved state
/// of the last scope, for Settings and the tab accessory.
@MainActor
@Observable
final class SiteHistoryOnboardingLifecycle {
    typealias Sleep = @MainActor (TimeInterval) async throws -> Void

    /// Slices per background opportunity (about two months); expiration may end it sooner.
    static let backgroundSlices = 20

    private let onboarding: SiteHistoryOnboarding
    private let store: SiteHistoryOnboardingStore
    private let ledgers: SiteHistoryDayLedgerStore
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

    @ObservationIgnored private var foreground: ForegroundRun?
    /// A background opportunity's run, so sign-out can stop it too.
    @ObservationIgnored private var background: Task<SiteHistoryOnboarding.Outcome, Never>?
    /// Moved by `stop()`, so work that started in an earlier session asks for no more time.
    @ObservationIgnored private var session = 0
    /// The scope the next background opportunity is for.
    private(set) var lastScope: SolarForecastSiteScope?
    private(set) var status: SiteHistoryStatus?
    @ObservationIgnored private var statusGeneration = 0

    init(
        onboarding: SiteHistoryOnboarding,
        store: SiteHistoryOnboardingStore = .shared,
        ledgers: SiteHistoryDayLedgerStore = .shared,
        isHistoryEnabled: @escaping @MainActor (SolarForecastSiteScope) async -> Bool,
        scheduleBackground: @escaping @MainActor (Date?) -> Void,
        sleep: @escaping Sleep = { try await Task.sleep(for: .seconds($0)) },
        now: @escaping () -> Date = Date.init
    ) {
        self.onboarding = onboarding
        self.store = store
        self.ledgers = ledgers
        self.isHistoryEnabled = isHistoryEnabled
        self.scheduleBackground = scheduleBackground
        self.sleep = sleep
        self.now = now
        onboarding.onProgress = { [weak self] scope in
            guard let self, scope == lastScope else { return }
            Task { await self.refreshStatus() }
        }
    }

    /// Rereads the last scope's saved state. A newer read, or a change of scope while reading,
    /// wins over this one.
    func refreshStatus() async {
        guard let scope = lastScope else { return }
        statusGeneration += 1
        let generation = statusGeneration
        let progress = try? await store.progress(scope: scope)
        let throttle = try? await store.throttle(accountScopeID: scope.accountScopeID)
        let usable = await onboarding.hasUsableLayout(scope: scope)
        guard generation == statusGeneration, scope == lastScope else { return }
        let next = SiteHistoryStatus(
            scope: scope, progress: progress, throttledUntil: throttle, hasUsableLayout: usable)
        if status != next { status = next }
    }

    /// The foreground run in progress, for tests to await.
    var foregroundTask: Task<Void, Never>? { foreground?.task }

    /// Run `scope` in the foreground, replacing work for any other scope. Joins a run already
    /// in progress for the same scope.
    func activate(scope: SolarForecastSiteScope) {
        if lastScope != scope { lastScope = scope }
        Task { await refreshStatus() }
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
        background?.cancel()
        background = nil
        session += 1
        lastScope = nil
        status = nil
        statusGeneration += 1
        scheduleBackground(nil)
    }

    /// Forget a site's progress and day types: its run stops and the next activation starts it
    /// from today.
    func forget(scope: SolarForecastSiteScope) async {
        if foreground?.scope == scope {
            foreground?.task.cancel()
            foreground = nil
        }
        try? await store.remove(scope: scope)
        try? await ledgers.remove(scope: scope)
        await refreshStatus()
    }

    /// After the action a pause asked for (reconnecting Tesla, signing in) succeeds.
    func resumePaused(accountScopeID: String, reason: SiteHistoryOnboarding.PauseReason) async {
        try? await store.resumePaused(accountScopeID: accountScopeID, reason: reason)
        await refreshStatus()
    }

    /// One background opportunity: a bounded run, then when to ask for the next one.
    func runInBackground(scope: SolarForecastSiteScope, maxSlices: Int = backgroundSlices) async -> Date? {
        lastScope = scope
        let session = session
        guard await prepare(scope), session == self.session else { return nil }
        let run = Task { await onboarding.run(scope: scope, maxSlices: maxSlices) }
        background = run
        _ = await withTaskCancellationHandler { await run.value } onCancel: { run.cancel() }
        if background == run { background = nil }
        guard session == self.session else { return nil }
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
