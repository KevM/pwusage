import Foundation

/// Loads a site's older history on request, past the year detection reads: newest to oldest in
/// short slices, from where onboarding stopped to the server's history start. It makes no
/// detection decisions and keeps its own progress, so detection's state is untouched. As in
/// onboarding, the cursor moves only when a slice comes back `complete`, any other answer retries
/// the same slice, and a wait is returned for the caller to schedule.
@MainActor
final class SiteDeepHistory {
    typealias Outcome = SiteHistoryOnboarding.Outcome

    private enum Step {
        case advanced
        case retryNow
        case stop(Outcome)
    }

    private let environment: any SiteDeepHistoryEnvironment
    private let store: SiteDeepHistoryStore
    /// Where the walk starts, and the account's Tesla throttle.
    private let onboarding: SiteHistoryOnboardingStore
    private let now: () -> Date
    private var running: [SolarForecastSiteScope: Task<Outcome, Never>] = [:]
    /// Called after the site's progress is saved.
    var onProgress: ((SolarForecastSiteScope) -> Void)?

    init(
        environment: any SiteDeepHistoryEnvironment,
        store: SiteDeepHistoryStore = .shared,
        onboarding: SiteHistoryOnboardingStore = .shared,
        now: @escaping () -> Date = Date.init
    ) {
        self.environment = environment
        self.store = store
        self.onboarding = onboarding
        self.now = now
    }

    /// Work through slices until the walk stops, waits, or has asked for `maxSlices` slices.
    /// A second call for a site already running joins that run (a foreground walk and a background
    /// opportunity never overlap); a run that was cancelled is waited out and a wanted caller
    /// starts a fresh one.
    func run(scope: SolarForecastSiteScope, maxSlices: Int = .max) async -> Outcome {
        while let existing = running[scope] {
            let outcome = await existing.value
            if running[scope] == existing { running[scope] = nil }
            guard existing.isCancelled, !Task.isCancelled else { return outcome }
        }
        if Task.isCancelled { return .stopped }
        let task = Task { await self.perform(scope: scope, maxSlices: maxSlices) }
        running[scope] = task
        let outcome = await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
        if running[scope] == task { running[scope] = nil }
        return outcome
    }

    /// The user started loading (or continues): saved progress exists, active and not stopped, so a
    /// background opportunity may run it. Only the user's start creates it.
    func begin(scope: SolarForecastSiteScope) async {
        guard let zone = await environment.siteTimeZone(scope: scope),
              var progress = try? await start(scope: scope, timeZone: zone) else { return }
        if case .paused = progress.phase {
            progress.phase = .active
            progress.failures = 0
            progress.nextAttemptAt = nil
        }
        try? await store.save(progress, scope: scope, userStopped: false)
        onProgress?(scope)
    }

    func markStopped(scope: SolarForecastSiteScope) async {
        try? await store.markStopped(scope: scope)
        onProgress?(scope)
    }

    /// Whether the user asked for this walk and it has work left to try: saved, active, not stopped.
    func isWanted(scope: SolarForecastSiteScope) async -> Bool {
        guard let progress = try? await store.progress(scope: scope) else { return false }
        return progress.phase == .active && !progress.userStopped
    }

    /// The earliest the walk could make progress: the later of now, its backoff and the account's
    /// Tesla throttle; nil when it is not wanted (never started, stopped, paused or finished).
    func nextOpportunity(scope: SolarForecastSiteScope) async -> Date? {
        guard await isWanted(scope: scope), let progress = try? await store.progress(scope: scope) else { return nil }
        let throttle = try? await onboarding.throttle(accountScopeID: scope.accountScopeID)
        return [now(), throttle, progress.nextAttemptAt].compactMap(\.self).max()
    }

    private func perform(scope: SolarForecastSiteScope, maxSlices: Int) async -> Outcome {
        guard let zone = await environment.siteTimeZone(scope: scope) else { return .unavailable }
        var progress: SiteDeepHistoryProgress
        do { progress = try await start(scope: scope, timeZone: zone) } catch { return .unavailable }
        var slices = 0
        while true {
            if (try? await store.progress(scope: scope))?.userStopped == true { return .stopped }
            if let blocked = await blockedOutcome(progress, scope: scope) { return blocked }
            guard let slice = nextSlice(progress, timeZone: zone) else {
                progress.phase = .finished(.reachedHistoryStart)
                return await finish(progress, scope: scope)
            }
            guard slices < maxSlices else { return .yielded }
            slices += 1
            let step = await attempt(slice, scope: scope, progress: &progress)
            if case .stop(.stopped) = step { return .stopped }
            try? await store.save(progress, scope: scope)
            onProgress?(scope)
            switch step {
            case .stop(let outcome): return outcome
            case .retryNow, .advanced: continue
            }
        }
    }

    /// The saved walk, or a new one from where onboarding stopped (today without it).
    private func start(scope: SolarForecastSiteScope, timeZone: TimeZone) async throws -> SiteDeepHistoryProgress {
        if let saved = try await store.progress(scope: scope) { return saved }
        if let basis = try await onboarding.progress(scope: scope) {
            return SiteDeepHistoryProgress(oldestChecked: basis.oldestChecked, historyStart: basis.historyStart)
        }
        return SiteDeepHistoryProgress(oldestChecked: SiteLocalDays.today(now: now(), timeZone: timeZone))
    }

    private func blockedOutcome(_ progress: SiteDeepHistoryProgress, scope: SolarForecastSiteScope) async -> Outcome? {
        if Task.isCancelled { return .stopped }
        if let retryAt = try? await onboarding.throttle(accountScopeID: scope.accountScopeID), retryAt > now() {
            return .waiting(until: retryAt, reason: .teslaLimited)
        }
        switch progress.phase {
        case .paused(let reason): return .paused(reason)
        case .finished(let reason): return .finished(reason)
        case .active: break
        }
        guard let next = progress.nextAttemptAt, next > now() else { return nil }
        return .waiting(until: next, reason: progress.waitReason ?? .retrying)
    }

    private func nextSlice(_ progress: SiteDeepHistoryProgress, timeZone: TimeZone) -> (from: String, days: Int)? {
        if let start = progress.historyStart, progress.oldestChecked <= start { return nil }
        guard let earliest = SiteLocalDays.adding(
            -SiteHistoryOnboarding.sliceDays, to: progress.oldestChecked, timeZone: timeZone) else { return nil }
        let from = max(earliest, progress.historyStart ?? earliest)
        guard let days = SiteLocalDays.days(from: from, to: progress.oldestChecked, timeZone: timeZone), days > 0
        else { return nil }
        return (from, days)
    }

    private func attempt(
        _ slice: (from: String, days: Int), scope: SolarForecastSiteScope, progress: inout SiteDeepHistoryProgress
    ) async -> Step {
        do {
            let response = try await environment.fill(siteID: scope.siteID, from: slice.from, days: slice.days)
            guard !Task.isCancelled else { return .stop(.stopped) }
            guard case .enabled(let fill) = response else {
                progress.phase = .finished(.historyUnavailable)
                return .stop(.finished(.historyUnavailable))
            }
            try await environment.storeDays(fill, scope: scope)
            guard !Task.isCancelled else { return .stop(.stopped) }
            progress.historyStart = fill.historyStart
            return record(fill.status, slice: slice, loaded: fill.days.count, progress: &progress)
        } catch {
            return await failed(error, scope: scope, progress: &progress)
        }
    }

    private func record(
        _ status: MobileSolarHistoryFill.Status, slice: (from: String, days: Int), loaded: Int,
        progress: inout SiteDeepHistoryProgress
    ) -> Step {
        switch status {
        case .complete:
            progress.oldestChecked = slice.from
            progress.daysLoaded += loaded
            progress.failures = 0
            progress.nextAttemptAt = nil
            progress.waitReason = nil
            return .advanced
        case .partial:
            progress.failures += 1
            guard progress.failures >= SiteHistoryOnboarding.partialRetries else { return .retryNow }
            let attempt = progress.failures - SiteHistoryOnboarding.partialRetries + 1
            return wait(.retrying, after: SiteHistoryOnboarding.backoff(60, attempt: attempt), progress: &progress)
        case .busy:
            progress.failures += 1
            let delay = min(SiteHistoryOnboarding.backoff(30, attempt: progress.failures), 900)
            return wait(.busy, after: delay, progress: &progress)
        }
    }

    private func failed(
        _ error: any Error, scope: SolarForecastSiteScope, progress: inout SiteDeepHistoryProgress
    ) async -> Step {
        if error is CancellationError || Task.isCancelled { return .stop(.stopped) }
        switch error {
        case MobileSolarHistoryFillError.rateLimited(let retryAt, _),
             MobileSolarHistoryFillError.teslaUnavailable(let retryAt):
            try? await onboarding.setThrottle(retryAt, accountScopeID: scope.accountScopeID)
            return .stop(.waiting(until: retryAt, reason: .teslaLimited))
        case MobileSolarHistoryFillError.teslaReconnectRequired:
            progress.phase = .paused(.reconnectTesla)
            return .stop(.paused(.reconnectTesla))
        case PWUsageAPIError.signInRequired:
            progress.phase = .paused(.signIn)
            return .stop(.paused(.signIn))
        default:
            progress.failures += 1
            return wait(.retrying, after: SiteHistoryOnboarding.backoff(60, attempt: progress.failures),
                        progress: &progress)
        }
    }

    private func wait(
        _ reason: SiteHistoryOnboarding.WaitReason, after delay: TimeInterval, progress: inout SiteDeepHistoryProgress
    ) -> Step {
        let until = now().addingTimeInterval(delay)
        progress.nextAttemptAt = until
        progress.waitReason = reason
        return .stop(.waiting(until: until, reason: reason))
    }

    private func finish(_ progress: SiteDeepHistoryProgress, scope: SolarForecastSiteScope) async -> Outcome {
        guard !Task.isCancelled, case .finished(let reason) = progress.phase else { return .stopped }
        try? await store.save(progress, scope: scope)
        onProgress?(scope)
        return .finished(reason)
    }
}
