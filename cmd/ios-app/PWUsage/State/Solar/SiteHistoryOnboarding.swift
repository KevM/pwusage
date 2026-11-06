import Foundation

/// Imports a site's recent history, then keeps reaching back toward a high-confidence layout. A
/// layout that is already high confidence stops after the recent days and sorts them once.
/// Otherwise a clear-day pass sorts the stored days once six checked days are unsorted; full detection runs only when a
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
    /// All a high-confidence layout still loads: the days forecast correction reads. Detection
    /// needs no more from this job, because the ordinary sync reads every day the server has.
    static let recentDays = SolarHistoryStore.actualsDays
    /// Not a promise: the solar search may end earlier or continue past it.
    static let initialCheckpointDays = 90
    static let reassessEveryDays = 30
    /// Unsorted checked days that run the clear-day pass: two slices' worth.
    static let sortEveryDays = 6
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

    func acknowledgeReveal(scope: SolarForecastSiteScope) async {
        await environment.acknowledgeReveal(scope: scope)
    }

    /// One pass without detection for a finished site whose days were never sorted, for its strip.
    func sortDaysIfUnsorted(scope: SolarForecastSiteScope) async {
        guard var progress = try? await store.progress(scope: scope), case .finished = progress.phase,
              (try? await ledgers.ledger(scope: scope)) == nil,
              let zone = await environment.siteTimeZone(scope: scope) else { return }
        let checked = progress.checkedDays(timeZone: zone)
        _ = await pass(&progress, scope: scope, checked: checked, detection: .never)
        if !Task.isCancelled { try? await store.save(progress, scope: scope) }
        onProgress?(scope)
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

    /// After a complete slice: a high-confidence layout (one iCloud brought back, say) loads only
    /// the recent days, then sorts once without detection; without a location the search ends at the
    /// initial checkpoint; otherwise each due sort runs the clear-day pass, which may run full detection.
    private func decideAfterSlice(
        _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope, timeZone: TimeZone
    ) async -> FinishReason? {
        let checked = progress.checkedDays(timeZone: timeZone)
        if await environment.layoutConfidence(scope: scope) == .high {
            guard checked >= Self.recentDays else { return nil }
            return await finishHighLayout(&progress, scope: scope, checked: checked)
        }
        guard await environment.hasLocation(scope: scope) else {
            return checked >= Self.initialCheckpointDays ? .locationNeeded : nil
        }
        if Self.sortDue(progress, checked: checked),
           let result = await pass(&progress, scope: scope, checked: checked, detection: .whenDue),
           let reason = Self.finishReason(result, atBound: false) {
            return reason
        }
        if checked >= Self.initialCheckpointDays, progress.producingDays == 0 { return .noSolarProduction }
        return nil
    }

    /// Whether a clear-day pass runs full detection: when it is due, at the bound, or not at all.
    enum PassDetection { case whenDue, atBound, never }

    /// The clear-day pass: sorts the stored days and saves them to the ledger, with full
    /// detection as `detection` allows (never at a high-confidence finish, which still sorts the
    /// days for the strip). Returns the detection's result.
    private func pass(
        _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope, checked: Int,
        detection: PassDetection
    ) async -> DetectedSolarLayout? {
        guard let days = await environment.classifyDays(scope: scope), !Task.isCancelled else { return nil }
        progress.producingDays = days.producingDays
        let previous = try? await ledgers.ledger(scope: scope)
        var ledger = SiteHistoryDayLedger(classification: days)
        ledger.checkpoint = SiteHistoryCheckpoint(
            ranAt: now(), producingDays: days.producingDays, clearDays: days.clearDays,
            azimuthRange90: previous?.checkpoint?.azimuthRange90)
        // Saved before detection, which can take minutes, so the strip shows the sorted days now.
        if (try? await ledgers.save(ledger, scope: scope)) != nil { progress.sortedCheckedDays = checked }
        guard !Task.isCancelled else { return nil }
        onProgress?(scope)
        let due = switch detection {
        case .whenDue: Self.detectionDue(days, progress: progress, checked: checked)
        case .atBound:
            days.producingDays >= SolarLayoutDetector.minHistoryDays && checked > progress.lastAssessedCheckedDays
        case .never: false
        }
        guard due else { return nil }
        let result = await environment.detect(scope: scope)
        // A detection cut off counts as not run, so the next pass tries again.
        guard !Task.isCancelled else { return nil }
        progress.lastAssessedCheckedDays = checked
        progress.detectedTargets = Target.reached(producingDays: days.producingDays, clearDays: days.clearDays)
            .sorted { $0.rawValue < $1.rawValue }
        guard let result else { return nil }
        progress.lastOutlook = SolarLayoutDetector.historyOutlook(result)
        if let largest = result.planes.max(by: { $0.effectiveKw < $1.effectiveKw }) {
            ledger.checkpoint?.azimuthRange90 = largest.azimuthRange90
            try? await ledgers.save(ledger, scope: scope)
        }
        return result
    }

    /// The one clear-day pass, without detection, for a site whose layout is already high
    /// confidence, and its finish reason. A lost pass is made up once by `sortDaysIfUnsorted`.
    private func finishHighLayout(
        _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope, checked: Int
    ) async -> FinishReason {
        _ = await pass(&progress, scope: scope, checked: checked, detection: .never)
        return progress.lastAssessedCheckedDays == 0 ? .layoutAlreadyUsable : .layoutFound
    }

    /// The search reached the history start or a year back: sort and assess what it found once more
    /// (only sort, when the layout is already high confidence).
    private func finishAtBound(
        _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope, timeZone: TimeZone
    ) async -> FinishReason {
        let checked = progress.checkedDays(timeZone: timeZone)
        if await environment.layoutConfidence(scope: scope) == .high {
            return await finishHighLayout(&progress, scope: scope, checked: checked)
        }
        if await environment.hasLocation(scope: scope),
           let result = await pass(&progress, scope: scope, checked: checked, detection: .atBound),
           let reason = Self.finishReason(result, atBound: true) {
            return reason
        }
        let oneYear = SiteLocalDays.adding(-Self.maxDaysBack, to: progress.checkedUntil, timeZone: timeZone) ?? ""
        return (progress.historyStart ?? "") >= oneYear ? .reachedHistoryStart : .reachedOneYear
    }

    private func finish(
        _ reason: FinishReason, _ progress: inout SiteHistoryOnboardingProgress, scope: SolarForecastSiteScope
    ) async -> Outcome {
        guard !Task.isCancelled else { return .stopped }
        progress.phase = .finished(reason)
        try? await store.save(progress, scope: scope)
        onProgress?(scope)
        return .finished(reason)
    }
}
