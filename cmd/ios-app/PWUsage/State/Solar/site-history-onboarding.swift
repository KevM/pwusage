import Foundation

/// What the onboarding job needs from the app: the server fill, the on-device history and layout.
@MainActor
protocol SiteHistoryOnboardingEnvironment: AnyObject {
    func fill(siteID: String, from: String, days: Int) async throws -> MobileSolarHistoryFillResponse
    /// Keep a fill's returned days in the on-device solar history.
    func storeDays(_ fill: MobileSolarHistoryFill, scope: SolarForecastSiteScope) async throws
    /// The site's time zone, nil while history is unavailable.
    func siteTimeZone(scope: SolarForecastSiteScope) async -> TimeZone?
    func hasLocation(scope: SolarForecastSiteScope) async -> Bool
    /// Whether the site already has a layout the forecast can use.
    func hasUsableLayout(scope: SolarForecastSiteScope) async -> Bool
    /// The detector's producing-day gate on the stored history; nil without a location.
    func readiness(scope: SolarForecastSiteScope) async -> SolarLayoutReadiness?
    /// Run detection now, outside the ordinary schedule, and keep its result.
    func detect(scope: SolarForecastSiteScope) async -> DetectedSolarLayout?
}

/// Imports a site's recent history, then keeps reaching back while detector feedback says more
/// history may help. Walks newest first in short slices from yesterday, so the recent days come
/// first; the cursor moves only when a whole slice comes back `complete`, and any other answer
/// retries the same slice (the server skips the days it already stored). Never sleeps: a wait is
/// returned for the caller to schedule, and iOS may resume much later.
@MainActor
final class SiteHistoryOnboarding {
    enum PauseReason: String, Codable, Sendable { case reconnectTesla, signIn }

    enum FinishReason: String, Codable, Sendable {
        case layoutFound, layoutAlreadyUsable, reachedHistoryStart, reachedOneYear
        case noSolarProduction, locationNeeded, detectorNeedsOtherAction, historyUnavailable
    }

    enum WaitReason: String, Codable, Sendable { case retrying, busy, teslaLimited }

    enum Outcome: Equatable, Sendable {
        case finished(FinishReason)
        case paused(PauseReason)
        /// Ask again no earlier than `until`.
        case waiting(until: Date, reason: WaitReason)
        /// The run used its slice budget; there is more to do.
        case yielded
        case stopped
        /// The site's history is not available yet (no time zone).
        case unavailable
    }

    static let sliceDays = 3
    static let recentDays = 14
    /// Not a promise: the solar search may end earlier or continue past it.
    static let initialCheckpointDays = 90
    static let reassessEveryDays = 30
    static let maxDaysBack = 365
    static let partialRetries = 3

    private enum Step {
        case advanced
        case retryNow
        case stop(Outcome)
    }

    private let environment: any SiteHistoryOnboardingEnvironment
    private let store: SiteHistoryOnboardingStore
    private let now: () -> Date
    private var running: [SolarForecastSiteScope: Task<Outcome, Never>] = [:]

    init(
        environment: any SiteHistoryOnboardingEnvironment,
        store: SiteHistoryOnboardingStore = .shared,
        now: @escaping () -> Date = Date.init
    ) {
        self.environment = environment
        self.store = store
        self.now = now
    }

    /// Work through slices until the job stops, waits, or has asked for `maxSlices` slices.
    /// A second call for a site already running joins that run.
    func run(scope: SolarForecastSiteScope, maxSlices: Int = .max) async -> Outcome {
        if let existing = running[scope] { return await existing.value }
        let task = Task { await self.perform(scope: scope, maxSlices: maxSlices) }
        running[scope] = task
        let outcome = await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
        if running[scope] == task { running[scope] = nil }
        return outcome
    }

    private func perform(scope: SolarForecastSiteScope, maxSlices: Int) async -> Outcome {
        guard let zone = await environment.siteTimeZone(scope: scope) else { return .unavailable }
        let stored: SiteHistoryOnboardingProgress?
        do { stored = try await store.progress(scope: scope) } catch { return .unavailable }
        var progress = stored ?? SiteHistoryOnboardingProgress(
            checkedUntil: SiteLocalDays.today(now: now(), timeZone: zone))
        var slices = 0
        while true {
            if let blocked = await blockedOutcome(progress, scope: scope) { return blocked }
            guard let slice = nextSlice(progress, timeZone: zone) else {
                let reason = await finishAtBound(&progress, scope: scope, timeZone: zone)
                return await finish(reason, &progress, scope: scope)
            }
            guard slices < maxSlices else { return .yielded }
            slices += 1
            let step = await attempt(slice, scope: scope, progress: &progress)
            await save(after: step, progress, scope: scope)
            switch step {
            case .stop(let outcome): return outcome
            case .retryNow: continue
            case .advanced:
                if let outcome = await afterAdvance(&progress, scope: scope, timeZone: zone) { return outcome }
            }
        }
    }

    /// A lost save only repeats a slice the server will skip. A cancelled attempt changed nothing,
    /// and saving it after sign-out's cleanup would bring the file back.
    private func save(
        after step: Step, _ progress: SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope
    ) async {
        if case .stop(.stopped) = step { return }
        try? await store.save(progress, scope: scope)
    }

    /// The checkpoint decision after a complete slice: a finish, or nil to keep going.
    private func afterAdvance(
        _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope, timeZone: TimeZone
    ) async -> Outcome? {
        if let reason = await decideAfterSlice(&progress, scope: scope, timeZone: timeZone) {
            return await finish(reason, &progress, scope: scope)
        }
        try? await store.save(progress, scope: scope)
        return nil
    }

    /// Why the next slice cannot be asked for yet: cancellation, a pause or finish, a backoff, or
    /// the account's Tesla throttle.
    private func blockedOutcome(
        _ progress: SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope
    ) async -> Outcome? {
        if Task.isCancelled { return .stopped }
        if let retryAt = try? await store.throttle(accountScopeID: scope.accountScopeID), retryAt > now() {
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

    // MARK: - Slices

    private func lowerBound(_ progress: SiteHistoryOnboardingProgress, timeZone: TimeZone) -> String {
        let oneYear = SiteLocalDays.adding(-Self.maxDaysBack, to: progress.checkedUntil, timeZone: timeZone)
            ?? progress.checkedUntil
        return max(progress.historyStart ?? oneYear, oneYear)
    }

    private func nextSlice(
        _ progress: SiteHistoryOnboardingProgress, timeZone: TimeZone
    ) -> (from: String, days: Int)? {
        let bound = lowerBound(progress, timeZone: timeZone)
        guard progress.oldestChecked > bound,
              let earliest = SiteLocalDays.adding(-Self.sliceDays, to: progress.oldestChecked, timeZone: timeZone)
        else { return nil }
        let from = max(earliest, bound)
        guard let days = SiteLocalDays.days(from: from, to: progress.oldestChecked, timeZone: timeZone), days > 0
        else { return nil }
        return (from, days)
    }

    private func attempt(
        _ slice: (from: String, days: Int), scope: SolarForecastSiteScope, progress: inout SiteHistoryOnboardingProgress
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
            return record(fill.status, slice: slice, progress: &progress)
        } catch {
            return await failed(error, scope: scope, progress: &progress)
        }
    }

    private func record(
        _ status: MobileSolarHistoryFill.Status, slice: (from: String, days: Int),
        progress: inout SiteHistoryOnboardingProgress
    ) -> Step {
        switch status {
        case .complete:
            progress.oldestChecked = slice.from
            progress.failures = 0
            progress.nextAttemptAt = nil
            progress.waitReason = nil
            return .advanced
        case .partial:
            progress.failures += 1
            guard progress.failures >= Self.partialRetries else { return .retryNow }
            return wait(.retrying, after: Self.backoff(60, attempt: progress.failures - Self.partialRetries + 1),
                        progress: &progress)
        case .busy:
            progress.failures += 1
            return wait(.busy, after: min(Self.backoff(30, attempt: progress.failures), 900), progress: &progress)
        }
    }

    private func failed(
        _ error: any Error, scope: SolarForecastSiteScope, progress: inout SiteHistoryOnboardingProgress
    ) async -> Step {
        if error is CancellationError || Task.isCancelled { return .stop(.stopped) }
        switch error {
        case MobileSolarHistoryFillError.rateLimited(let retryAt, _),
             MobileSolarHistoryFillError.teslaUnavailable(let retryAt):
            try? await store.setThrottle(retryAt, accountScopeID: scope.accountScopeID)
            return .stop(.waiting(until: retryAt, reason: .teslaLimited))
        case MobileSolarHistoryFillError.teslaReconnectRequired:
            progress.phase = .paused(.reconnectTesla)
            return .stop(.paused(.reconnectTesla))
        case PWUsageAPIError.signInRequired:
            progress.phase = .paused(.signIn)
            return .stop(.paused(.signIn))
        default:
            progress.failures += 1
            return wait(.retrying, after: Self.backoff(60, attempt: progress.failures), progress: &progress)
        }
    }

    private func wait(
        _ reason: WaitReason, after delay: TimeInterval, progress: inout SiteHistoryOnboardingProgress
    ) -> Step {
        let until = now().addingTimeInterval(delay)
        progress.nextAttemptAt = until
        progress.waitReason = reason
        return .stop(.waiting(until: until, reason: reason))
    }

    /// `base` doubled per attempt after the first, capped at an hour.
    private static func backoff(_ base: TimeInterval, attempt: Int) -> TimeInterval {
        min(base * pow(2, Double(max(attempt - 1, 0))), 3600)
    }

    // MARK: - Decisions

    private func decideAfterSlice(
        _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope, timeZone: TimeZone
    ) async -> FinishReason? {
        let checked = progress.checkedDays(timeZone: timeZone)
        guard checked >= Self.recentDays else { return nil }
        if progress.lastAssessedCheckedDays == 0, await environment.hasUsableLayout(scope: scope) {
            return .layoutAlreadyUsable
        }
        guard await environment.hasLocation(scope: scope) else {
            return checked >= Self.initialCheckpointDays ? .locationNeeded : nil
        }
        guard Self.assessmentDue(checked: checked, lastAssessed: progress.lastAssessedCheckedDays) else { return nil }
        return await assess(&progress, scope: scope, checked: checked)
    }

    /// First when the detector's minimum could be met, then every 30 checked days, plus once at
    /// the initial checkpoint.
    private static func assessmentDue(checked: Int, lastAssessed: Int) -> Bool {
        guard checked >= SolarLayoutDetector.minHistoryDays else { return false }
        return checked - lastAssessed >= reassessEveryDays
            || (checked >= initialCheckpointDays && lastAssessed < initialCheckpointDays)
    }

    private func assess(
        _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope, checked: Int
    ) async -> FinishReason? {
        progress.lastAssessedCheckedDays = checked
        guard let readiness = await environment.readiness(scope: scope) else { return nil }
        progress.producingDays = readiness.producingDays
        guard readiness.isReady else {
            return checked >= Self.initialCheckpointDays && readiness.producingDays == 0 ? .noSolarProduction : nil
        }
        guard let result = await environment.detect(scope: scope) else { return nil }
        let outlook = SolarLayoutDetector.historyOutlook(result)
        progress.lastOutlook = outlook
        switch outlook {
        case .usable: return .layoutFound
        case .needsOtherAction: return .detectorNeedsOtherAction
        case .moreHistoryMayHelp: return nil
        }
    }

    /// The search reached the history start or a year back: assess what it found once more.
    private func finishAtBound(
        _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope, timeZone: TimeZone
    ) async -> FinishReason {
        let checked = progress.checkedDays(timeZone: timeZone)
        if checked > progress.lastAssessedCheckedDays, checked >= SolarLayoutDetector.minHistoryDays,
           await environment.hasLocation(scope: scope),
           let reason = await assess(&progress, scope: scope, checked: checked),
           reason == .layoutFound || reason == .detectorNeedsOtherAction {
            return reason
        }
        let oneYear = SiteLocalDays.adding(-Self.maxDaysBack, to: progress.checkedUntil, timeZone: timeZone) ?? ""
        return (progress.historyStart ?? "") >= oneYear ? .reachedHistoryStart : .reachedOneYear
    }

    private func finish(
        _ reason: FinishReason, _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope
    ) async -> Outcome {
        progress.phase = .finished(reason)
        try? await store.save(progress, scope: scope)
        return .finished(reason)
    }
}
