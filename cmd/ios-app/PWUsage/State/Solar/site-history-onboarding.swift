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
    /// The confidence of the stored layout when the forecast can use it.
    func layoutConfidence(scope: SolarForecastSiteScope) async -> SolarLayoutConfidence?
    /// The clear-day pass over the stored history; nil without a location or history.
    func classifyDays(scope: SolarForecastSiteScope) async -> SolarDayClassification?
    /// What the phone holds for the site's status: the stored result, home location and days.
    func storedState(scope: SolarForecastSiteScope) async -> SiteHistoryStoredState
    /// Run detection now, outside the ordinary schedule, and keep its result.
    func detect(scope: SolarForecastSiteScope) async -> DetectedSolarLayout?
}

/// Imports a site's recent history, then keeps reaching back toward a high-confidence layout.
/// A clear-day pass sorts the stored days every second slice; full detection runs only when a
/// target is first reached (15 or 40 clear days, 180 producing days) or 30 checked days after the
/// last one. Walks newest first in short slices from yesterday, so the recent days come
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
    static let passEverySlices = 2
    static let maxDaysBack = 365
    static let partialRetries = 3

    private enum Step {
        case advanced
        case retryNow
        case stop(Outcome)
    }

    private let environment: any SiteHistoryOnboardingEnvironment
    private let store: SiteHistoryOnboardingStore
    private let ledgers: SiteHistoryDayLedgerStore
    private let now: () -> Date
    private var running: [SolarForecastSiteScope: Task<Outcome, Never>] = [:]
    /// Called after the site's progress is saved, so a status display can reread it.
    var onProgress: ((SolarForecastSiteScope) -> Void)?

    init(
        environment: any SiteHistoryOnboardingEnvironment,
        store: SiteHistoryOnboardingStore = .shared,
        ledgers: SiteHistoryDayLedgerStore = .shared,
        now: @escaping () -> Date = Date.init
    ) {
        self.environment = environment
        self.store = store
        self.ledgers = ledgers
        self.now = now
    }

    /// Work through slices until the job stops, waits, or has asked for `maxSlices` slices.
    /// A second call for a site already running joins that run. A run that was cancelled is
    /// waited out instead, and a caller that is still wanted starts a fresh one.
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
        onProgress?(scope)
    }

    /// Whether the site already has a layout the forecast can use.
    func hasUsableLayout(scope: SolarForecastSiteScope) async -> Bool {
        await environment.layoutConfidence(scope: scope) != nil
    }

    func hasLocation(scope: SolarForecastSiteScope) async -> Bool {
        await environment.hasLocation(scope: scope)
    }

    func storedState(scope: SolarForecastSiteScope) async -> SiteHistoryStoredState {
        await environment.storedState(scope: scope)
    }

    /// The checkpoint decision after a complete slice: a finish, or nil to keep going.
    private func afterAdvance(
        _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope, timeZone: TimeZone
    ) async -> Outcome? {
        if let reason = await decideAfterSlice(&progress, scope: scope, timeZone: timeZone) {
            return await finish(reason, &progress, scope: scope)
        }
        try? await store.save(progress, scope: scope)
        onProgress?(scope)
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
            let step = record(fill.status, slice: slice, progress: &progress)
            if case .advanced = step {
                progress.daysWithData += fill.days.count { $0.solarWh.contains { $0 != nil } }
            }
            return step
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
            progress.completeSlices = (progress.completeSlices ?? 0) + 1
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

    /// After a complete slice: a high-confidence layout ends the search once the recent days are
    /// in; without a location it ends at the initial checkpoint; otherwise every second slice runs
    /// the clear-day pass, which may run full detection.
    private func decideAfterSlice(
        _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope, timeZone: TimeZone
    ) async -> FinishReason? {
        let checked = progress.checkedDays(timeZone: timeZone)
        if checked >= Self.recentDays, await environment.layoutConfidence(scope: scope) == .high {
            return progress.lastAssessedCheckedDays == 0 ? .layoutAlreadyUsable : .layoutFound
        }
        guard await environment.hasLocation(scope: scope) else {
            return checked >= Self.initialCheckpointDays ? .locationNeeded : nil
        }
        if (progress.completeSlices ?? 0) % Self.passEverySlices == 0,
           let result = await pass(&progress, scope: scope, checked: checked, forceDetection: false),
           let reason = Self.finishReason(result, atBound: false) {
            return reason
        }
        if checked >= Self.initialCheckpointDays, progress.producingDays == 0 { return .noSolarProduction }
        return nil
    }

    /// Targets whose first crossing runs full detection.
    enum Target: String, Codable, Sendable {
        case clear15, clear40, producing180

        static func reached(producingDays: Int, clearDays: Int) -> Set<Target> {
            var targets: Set<Target> = []
            if clearDays >= 15 { targets.insert(.clear15) }
            if clearDays >= 40 { targets.insert(.clear40) }
            if producingDays >= 180 { targets.insert(.producing180) }
            return targets
        }
    }

    /// Full detection once the detector's producing-day minimum is met, when a target was reached
    /// since the last run, or 30 checked days after it.
    private static func detectionDue(
        _ days: SolarDayClassification, progress: SiteHistoryOnboardingProgress, checked: Int
    ) -> Bool {
        guard days.producingDays >= SolarLayoutDetector.minHistoryDays else { return false }
        let reached = Target.reached(producingDays: days.producingDays, clearDays: days.clearDays)
        return !reached.isSubset(of: Set(progress.detectedTargets ?? []))
            || checked - progress.lastAssessedCheckedDays >= reassessEveryDays
    }

    /// The clear-day pass: sorts the stored days and saves them to the ledger, with full
    /// detection when it is due (or forced, at the bound). Returns the detection's result.
    private func pass(
        _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope, checked: Int,
        forceDetection: Bool
    ) async -> DetectedSolarLayout? {
        guard let days = await environment.classifyDays(scope: scope), !Task.isCancelled else { return nil }
        progress.producingDays = days.producingDays
        let previous = try? await ledgers.ledger(scope: scope)
        var checkpoint = SiteHistoryCheckpoint(
            ranAt: now(), producingDays: days.producingDays, clearDays: days.clearDays,
            azimuthRange90: previous?.checkpoint?.azimuthRange90)
        var result: DetectedSolarLayout?
        let due = forceDetection
            ? days.producingDays >= SolarLayoutDetector.minHistoryDays && checked > progress.lastAssessedCheckedDays
            : Self.detectionDue(days, progress: progress, checked: checked)
        if due {
            progress.lastAssessedCheckedDays = checked
            progress.detectedTargets = Target.reached(producingDays: days.producingDays, clearDays: days.clearDays)
                .sorted { $0.rawValue < $1.rawValue }
            result = await environment.detect(scope: scope)
            if let result {
                progress.lastOutlook = SolarLayoutDetector.historyOutlook(result)
                if let largest = result.planes.max(by: { $0.effectiveKw < $1.effectiveKw }) {
                    checkpoint.azimuthRange90 = largest.azimuthRange90
                }
            }
        }
        guard !Task.isCancelled else { return nil }
        var ledger = SiteHistoryDayLedger(classification: days)
        ledger.checkpoint = checkpoint
        try? await ledgers.save(ledger, scope: scope)
        return result
    }

    /// High confidence ends the search; so does a usable layout at the bound, and a problem more
    /// history will not fix.
    private static func finishReason(_ result: DetectedSolarLayout, atBound: Bool) -> FinishReason? {
        switch SolarLayoutDetector.historyOutlook(result) {
        case .usable: atBound || result.confidence == SolarLayoutConfidence.high.rawValue ? .layoutFound : nil
        case .needsOtherAction: .detectorNeedsOtherAction
        case .moreHistoryMayHelp: nil
        }
    }

    /// The search reached the history start or a year back: sort and assess what it found once more.
    private func finishAtBound(
        _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope, timeZone: TimeZone
    ) async -> FinishReason {
        let checked = progress.checkedDays(timeZone: timeZone)
        if await environment.hasLocation(scope: scope),
           let result = await pass(&progress, scope: scope, checked: checked, forceDetection: true),
           let reason = Self.finishReason(result, atBound: true) {
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
        onProgress?(scope)
        return .finished(reason)
    }
}
