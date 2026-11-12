import Foundation
import Observation

enum SiteDeepHistoryPhase: Equatable {
    case idle, running, unavailable, finished
    case waiting(until: Date)
    case paused(SiteHistoryOnboarding.PauseReason)
}

/// What the Solar System screen and the tab accessory show of the deep-history walk, and the
/// foreground run behind it. The walk runs only in the foreground (the app model stops it when the
/// app leaves it, on sign-out and on a change of site); its saved progress resumes it later.
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

    /// Stop loading; what is loaded stays, and the saved cursor resumes later.
    func stop() async {
        stopRun()
        await refresh(finishing: true)
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
        try? await store.resume(scope: scope)
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
