import Foundation
import Observation

enum SiteDeepHistoryPhase: Equatable {
    case idle, running, unavailable, finished
    case waiting(until: Date)
    case paused(SiteHistoryOnboarding.PauseReason)
}

/// What the Solar System screen and the tab accessory show of the deep-history walk, and the
/// run behind it. The walk runs here in the foreground and from the shared background task
/// (`runInBackground`), but only once the user started it; the user's Stop ends both until they
/// continue. Leaving the foreground, sign-out and a change of site stop this run only, and a walk
/// the user did not stop picks itself up again on the next activation.
@MainActor
@Observable
final class SiteDeepHistoryModel {
    typealias Sleep = @MainActor (TimeInterval) async throws -> Void

    struct Status: Equatable {
        var phase = SiteDeepHistoryPhase.idle
        /// The oldest day loaded so far ("yyyy-MM-dd"), nil before the walk has loaded any.
        var loadedBack: String?
        var daysLoaded = 0

        var isLoading: Bool {
            switch phase {
            case .running, .waiting: true
            default: false
            }
        }
    }

    private let deepHistory: SiteDeepHistory
    private let store: SiteDeepHistoryStore
    private let sleep: Sleep
    private let now: () -> Date
    @ObservationIgnored private var run: (id: UUID, task: Task<Void, Never>)?
    private(set) var scope: SolarForecastSiteScope?
    private(set) var status = Status()

    init(
        deepHistory: SiteDeepHistory, store: SiteDeepHistoryStore = .shared,
        sleep: @escaping Sleep = { try await Task.sleep(for: .seconds($0)) },
        now: @escaping () -> Date = Date.init
    ) {
        self.deepHistory = deepHistory
        self.store = store
        self.sleep = sleep
        self.now = now
        deepHistory.onProgress = { [weak self] scope in
            guard let self, scope == self.scope else { return }
            Task { await self.refresh() }
        }
    }

    /// The run in progress, for tests to await.
    var runTask: Task<Void, Never>? { run?.task }

    /// The site the screen is about. A different site stops the run and rereads its saved state.
    func select(scope next: SolarForecastSiteScope) async {
        guard next != scope else { return }
        stopRun()
        scope = next
        status = Status()
        await refresh()
    }

    /// The app is in the foreground for `scope`: a walk the user started and did not stop (one that
    /// was running when the app left, or that progressed in the background) carries on by itself.
    func activate(scope next: SolarForecastSiteScope) async {
        await select(scope: next)
        guard run == nil, await deepHistory.isWanted(scope: next), scope == next, run == nil else { return }
        start()
    }

    /// Load the older history, or continue after a stop or a pause.
    func start() {
        guard let scope, run == nil else { return }
        let id = UUID()
        status.phase = .running
        run = (id, Task { [weak self] in
            await self?.walk(scope)
            if let self, run?.id == id { run = nil }
        })
    }

    /// The user's Stop: no run, here or in the background, until they continue.
    func stop() async {
        stopRun()
        if let scope { await deepHistory.markStopped(scope: scope) }
        await refresh(finishing: true)
    }

    /// Leaving the foreground: this run ends, but the walk stays wanted for the background and for
    /// the next activation.
    func suspend() async {
        stopRun()
        await refresh(finishing: true)
    }

    /// A background opportunity: nil unless the user started this site's walk and it is not stopped
    /// or finished. Joins a walk already running.
    func runInBackground(scope: SolarForecastSiteScope, maxSlices: Int) async -> SiteDeepHistory.Outcome? {
        guard await deepHistory.isWanted(scope: scope) else { return nil }
        let outcome = await deepHistory.run(scope: scope, maxSlices: maxSlices)
        if self.scope == scope, run == nil { await refresh(finishing: true) }
        return outcome
    }

    func nextOpportunity(scope: SolarForecastSiteScope) async -> Date? {
        await deepHistory.nextOpportunity(scope: scope)
    }

    /// Sign-out or a lost session: no work and nothing to show.
    func end() {
        stopRun()
        scope = nil
        status = Status()
    }

    /// After the action a pause asked for succeeds: the walk can continue.
    func resumePaused(accountScopeID: String) async {
        guard let scope, scope.accountScopeID == accountScopeID, run == nil else { return }
        try? await store.resume(scope: scope)
        await refresh()
        if await deepHistory.isWanted(scope: scope), run == nil, self.scope == scope { start() }
    }

    func forget(scope forgotten: SolarForecastSiteScope) async {
        if scope == forgotten { stopRun() }
        try? await store.remove(scope: forgotten)
        await refresh()
    }

    private func stopRun() {
        run?.task.cancel()
        run = nil
    }

    private func walk(_ scope: SolarForecastSiteScope) async {
        await deepHistory.begin(scope: scope)
        while !Task.isCancelled {
            status.phase = .running
            switch await deepHistory.run(scope: scope) {
            case .waiting(let until, _):
                status.phase = .waiting(until: until)
                do { try await sleep(max(until.timeIntervalSince(now()), 0)) } catch { return }
            case .unavailable:
                guard self.scope == scope, !Task.isCancelled else { return }
                status.phase = .unavailable
                return
            default:
                await refreshIfCurrent(scope)
                return
            }
        }
    }

    private func refreshIfCurrent(_ scope: SolarForecastSiteScope) async {
        guard self.scope == scope, !Task.isCancelled else { return }
        await refresh(finishing: true)
    }

    /// Rereads the saved progress. A running or waiting walk keeps its phase; once the walk has
    /// ended the saved phase decides.
    func refresh(finishing: Bool = false) async {
        guard let scope else { return }
        let progress = try? await store.progress(scope: scope)
        guard scope == self.scope else { return }
        var next = status
        next.loadedBack = (progress?.daysLoaded ?? 0) > 0 ? progress?.oldestChecked : nil
        next.daysLoaded = progress?.daysLoaded ?? 0
        if finishing || !status.isLoading {
            switch progress?.phase {
            case .paused(let reason): next.phase = .paused(reason)
            case .finished(.historyUnavailable): next.phase = .unavailable
            case .finished: next.phase = .finished
            default: next.phase = .idle
            }
        }
        if next != status { status = next }
    }
}
