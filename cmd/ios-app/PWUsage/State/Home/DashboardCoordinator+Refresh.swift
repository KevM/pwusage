import Combine
import Foundation

extension DashboardCoordinator {
    /// Called by the foreground timer and lifecycle events. Missed intervals collapse to one request.
    func refreshDue() async {
        await refreshAll(trigger: .scheduled)
    }

    /// Refreshes live power readings followed by bill estimates.
    func refreshAll(
        trigger: RefreshTrigger, revalidatingHistory: Bool = false, showingBillEarly: Bool = false
    ) async {
        let generation = siteGeneration
        guard canStillRefresh(trigger: trigger, generation: generation) else { return }
        let historyAtStart = historyGeneration
        let billAttemptsAtStart = billAttempts
        if trigger == .userGesture { manualRefreshCount += 1 }
        defer { finishRefresh(trigger: trigger, generation: generation) }
        let billWasFetching = billTask != nil
        if showingBillEarly, bill.response == nil {
            launchBillTaskIfNeeded(trigger: trigger, requestTime: now(), generation: generation)
        }
        await refreshPower(force: trigger.skipsCadence)
        guard canStillRefresh(trigger: trigger, generation: generation) else { return }
        if trigger == .userGesture {
            await waitForLiveTaskWithoutImport(generation: generation)
            guard canStillRefresh(trigger: trigger, generation: generation) else { return }
        }
        let requestTime = now()

        startLiveTaskIfNeeded(
            trigger: trigger, generation: generation,
            revalidatingHistory: revalidatingHistory, historyAtStart: historyAtStart
        )
        guard await waitForRequest(liveTask) else { return }
        guard canStillRefresh(trigger: trigger, generation: generation) else { return }

        let waitsForBill = await reconcileBillAfterLive(
            trigger: trigger, requestTime: requestTime,
            billStartedDuringRefresh: billWasFetching || billAttempts > billAttemptsAtStart,
            billNeedsRecovery: revalidatingHistory && hasNewBillInputs(since: historyAtStart),
            generation: generation
        )
        guard waitsForBill else { return }
        _ = await waitForRequest(billTask)
    }

    private func finishRefresh(trigger: RefreshTrigger, generation: Int) {
        guard generation == siteGeneration else { return }
        if trigger == .userGesture { manualRefreshCount -= 1 }
        if canRequestAccountData, manualRefreshCount == 0, liveTask == nil, billTask == nil, !Task.isCancelled {
            refreshSettled = true
        }
    }

    /// A poll already running may answer from cache without importing history. A
    /// pull must not settle for that, so it lets the poll finish and sends its own.
    private func waitForLiveTaskWithoutImport(generation: Int) async {
        while generation == siteGeneration, !liveTaskImportsHistory, let liveTask {
            guard await waitForRequest(liveTask) else { return }
        }
    }

    private func startLiveTaskIfNeeded(
        trigger: RefreshTrigger, generation: Int, revalidatingHistory: Bool, historyAtStart: Int
    ) {
        guard liveTask == nil else { return }
        if trigger == .userGesture, historyGeneration > historyAtStart,
           live.response?.historyRefresh?.status == .changed { return }
        let through = live.response?.sources.energyDataThrough
        let historyIsStale = through.map { now().timeIntervalSince($0) > 60 * 60 } ?? true
        let importIsPending = live.response?.historyRefresh?.status == .pending
        let usesShortInterval = !usesLivePowerEndpoint || (revalidatingHistory && historyIsStale) || importIsPending
        let interval = usesShortInterval ? Self.liveInterval : Self.summaryInterval
        guard trigger.skipsCadence
            || live.cadence.isDue(at: cadenceNow(), interval: .seconds(interval)) else { return }
        refreshSettled = false
        let siteID = selectedSiteID
        let importsHistory = trigger == .userGesture
        liveTaskImportsHistory = importsHistory
        liveTask = Task { await performLive(siteID: siteID, generation: generation, importsHistory: importsHistory) }
    }

    private func hasNewBillInputs(since historyAtStart: Int) -> Bool {
        guard historyGeneration > historyAtStart, latestBillHistoryGeneration < historyGeneration,
              !live.isUnavailable, let response = live.response else { return false }
        if response.historyRefresh?.status == .changed { return true }
        guard let liveThrough = response.sources.energyDataThrough else { return false }
        return liveThrough > (bill.response?.sources.energyDataThrough ?? .distantPast)
    }

    /// Reconciles the bill request against the live import that just ran. Returns false
    /// when the caller must stop without waiting on the bill task.
    private func reconcileBillAfterLive(
        trigger: RefreshTrigger,
        requestTime: Date,
        billStartedDuringRefresh: Bool,
        billNeedsRecovery: Bool,
        generation: Int
    ) async -> Bool {
        // A pull waiting for the scheduled summary owns the bill check that
        // follows it. Recalculating here could bill both sides of that import.
        guard trigger != .scheduled || manualRefreshCount == 0 else { return false }
        if !billStartedDuringRefresh {
            let billTrigger = billNeedsRecovery ? .automaticRecovery : trigger
            launchBillTaskIfNeeded(trigger: billTrigger, requestTime: requestTime, generation: generation)
        } else if latestBillHistoryGeneration < historyGeneration {
            // Another caller attempted the bill while live was still importing
            // history, so that bill is stale. Let it finish, then recalculate
            // once, whichever waiting refresh gets here first.
            _ = await waitForRequest(billTask)
            // Cancellation is deliberately not checked here: the waiter already
            // committed to recalculating the stale bill, and abandoning it would
            // leave the billed history stale for a full cadence window.
            guard canStillReconcile(trigger: trigger, generation: generation),
                  trigger != .scheduled || manualRefreshCount == 0 else { return false }
            if latestBillHistoryGeneration < historyGeneration {
                launchBillTaskIfNeeded(trigger: .userGesture, requestTime: now(), generation: generation)
            }
        }
        // Otherwise a bill already followed this live request. Comparing its
        // newer attempt with the pre-wait time would read as a backwards clock
        // and send a duplicate request.
        return true
    }

    /// Account, site and foreground still match the refresh that is running.
    /// Cancellation is deliberately absent: a cancelled waiter still finishes
    /// work it already committed to, such as a stale-bill recalculation.
    func canStillReconcile(trigger: RefreshTrigger, generation: Int) -> Bool {
        guard canRequestAccountData, generation == siteGeneration else { return false }
        return trigger != .scheduled || isForeground
    }

    func canStillRefresh(trigger: RefreshTrigger, generation: Int) -> Bool {
        // A cancelled caller (a refreshable view going away, a timer loop
        // stopping) must not start the next leg of the refresh.
        canStillReconcile(trigger: trigger, generation: generation) && !Task.isCancelled
    }

    /// Refreshes the bill estimate, subject to the trigger's cadence.
    func refreshBill(trigger: RefreshTrigger) async {
        guard canRequestAccountData else { return }
        if trigger == .scheduled {
            guard isForeground else { return }
        }
        let requestTime = now()
        let generation = siteGeneration

        launchBillTaskIfNeeded(trigger: trigger, requestTime: requestTime, generation: generation)

        _ = await waitForRequest(billTask)
    }

    private func launchBillTaskIfNeeded(trigger: RefreshTrigger, requestTime: Date, generation: Int) {
        guard billTask == nil else { return }
        let cadence = cadenceNow()
        let due: Bool
        switch trigger {
        case .userGesture, .automaticRecovery: due = true
        case .screenAppearance:
            due = bill.cadence.isDue(at: cadence, interval: .seconds(Self.billMinimumInterval))
        case .scheduled:
            due = bill.cadence.isDue(at: cadence, interval: .seconds(Self.billInterval))
                || (energyDataIsAgingForForecast(at: requestTime)
                    && bill.cadence.isDue(at: cadence, interval: .seconds(Self.billMinimumInterval)))
        }
        guard due else { return }
        billAttempts += 1
        latestBillHistoryGeneration = historyGeneration
        let siteID = selectedSiteID
        billTask = Task { await performBill(siteID: siteID, generation: generation) }
    }

    /// A forecast is available and measured energy is nearly too old for the comparison.
    func energyDataIsAgingForForecast(at date: Date) -> Bool {
        guard forecastConnectionForConsumers == .ready,
              let through = bill.response?.sources.energyDataThrough else { return false }
        return date.timeIntervalSince(through) >= Self.forecastEnergyDataRefreshAge
    }

    /// Whether the bill response on hand was fetched inside the appearance floor.
    func billIsFresh(at date: Date) -> Bool {
        guard let lastSuccess = bill.lastSuccess else { return false }
        let age = date.timeIntervalSince(lastSuccess)
        return age >= 0 && age < Self.billMinimumInterval
    }

    func refreshPower(force: Bool) async {
        guard canRequestAccountData, usesLivePowerEndpoint,
              let powerAPI = api as? any MobileLivePowerDataAPI else { return }
        if let powerTask {
            _ = await waitForRequest(powerTask)
            return
        }
        let due = power.cadence.isDue(at: cadenceNow(), interval: .seconds(Self.livePowerInterval))
        guard force || (due && livePowerIsVisible) else { return }
        let generation = siteGeneration
        let siteID = selectedSiteID
        powerTask = Task {
            defer { if generation == siteGeneration { powerTask = nil } }
            do {
                let response = try await powerAPI.fetchLivePower(siteID: siteID).validating(siteID: siteID)
                guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return }
                power.response = response
                power.lastSuccess = now()
                recordAttempt(.power)
                power.isUnavailable = false
                teslaConnectionRestored()
            } catch {
                handlePowerFailure(error, generation: generation)
            }
        }
        _ = await waitForRequest(powerTask)
    }

    /// Live power polls only while a selected screen shows it. Returning to one
    /// fetches a reading that fell due in the meantime, without waiting for the timer.
    func livePowerVisibilityChanged(_ isVisible: Bool) {
        guard isVisible != livePowerIsVisible else { return }
        livePowerIsVisible = isVisible
        guard isVisible, isForeground else { return }
        Task { await refreshPower(force: false) }
    }

    private func handlePowerFailure(_ error: Error, generation: Int) {
        guard !isAbandonedRequest() else { return }
        guard generation == siteGeneration, canRequestAccountData else { return }
        recordAttempt(.power)
        if let rejected = error as? PWUsageAPIError,
           case .requestRejected(let statusCode, _) = rejected, statusCode == 404 {
            // The fast route is only a fallback: an older server can still serve
            // the combined endpoint, so this failure is not an unavailable reading.
            livePowerEndpointAvailable = false
            power.isUnavailable = false
            return
        }
        handle(error, generation: generation, endpoint: .power)
    }

    func performBill(siteID: String, generation: Int) async {
        defer {
            if generation == siteGeneration { billTask = nil }
        }
        do {
            let response: MobileBillResponse
            if let conditionalAPI = api as? any MobileConditionalDashboardDataAPI {
                response = try await conditionalAPI.fetchBill(siteID: siteID, reusing: bill.response)
            } else {
                response = try await api.fetchBill(siteID: siteID)
            }
            guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return }
            recordAttempt(.bill)
            bill.response = response
            billSuccessGeneration += 1
            let successTime = now()
            bill.lastSuccess = successTime
            bill.isRestored = false
            cache?.storeBill(response, at: successTime)
            bill.isUnavailable = false
        } catch {
            guard !isAbandonedRequest() else { return }
            guard generation == siteGeneration else { return }
            recordAttempt(.bill)
            handle(error, generation: generation, endpoint: .bill)
        }
    }

    enum Endpoint { case live, bill, power }

    func handle(_ error: Error, generation: Int, endpoint: Endpoint) {
        guard generation == siteGeneration else { return }
        if error as? PWUsageAPIError == .signInRequired {
            // Already nil and cancelled in here; cancelling again would imply
            // the sign-in-required path does something extra that it does not.
            authenticationInvalidated()
            requiresSignIn = true
            isForeground = false
            stopTimer()
            return
        }
        if error as? PWUsageAPIError == .requestRejected(statusCode: 409, message: "TESLA_CONNECTION_REQUIRED") {
            requiresTeslaReconnect = true
            batteryHold.failure = .needsReauthentication
        }
        switch endpoint {
        case .live:
            live.isUnavailable = true
        case .bill:
            bill.isUnavailable = true
        case .power:
            power.isUnavailable = true
        }
    }

    func teslaConnectionRestored() {
        guard !requiresTeslaCommandReauthorization else { return }
        if requiresTeslaReconnect, batteryHold.failure == .needsReauthentication {
            batteryHold.failure = nil
        }
        requiresTeslaReconnect = false
    }

    /// Records a completed attempt on the endpoint's monotonic cadence. Callers
    /// record after a request finishes and never for an abandoned one, so a
    /// cancelled request cannot consume a retry window.
    func recordAttempt(_ endpoint: Endpoint) {
        let cadence = cadenceNow()
        switch endpoint {
        case .live:
            live.cadence.recordAttempt(at: cadence)
        case .bill:
            bill.cadence.recordAttempt(at: cadence)
        case .power:
            power.cadence.recordAttempt(at: cadence)
        }
    }

    /// Awaits an in-flight request and reports whether the caller is still active.
    /// `refreshAll` is non-throwing, so a cancelled caller must stop it explicitly
    /// between legs rather than by interrupting the `Task.value` await.
    private func waitForRequest(_ task: Task<Void, Never>?) async -> Bool {
        guard let task else { return !Task.isCancelled }
        await task.value
        return !Task.isCancelled
    }

    /// Whether this request was abandoned by the app itself. Only this task's
    /// cancellation counts: a cancellation error the app did not cause is a real
    /// failure, and a cancelled task's result is discarded whatever it throws.
    func isAbandonedRequest() -> Bool {
        Task.isCancelled
    }

    func startTimer() {
        guard timerTask == nil, let timerInterval else { return }
        let token = UUID()
        timerTaskToken = token
        timerTask = Task { [weak self] in
            // Every exit path — sleep cancellation, a guard failure, or the loop
            // condition — must clear the handle, or a later startTimer() is a no-op.
            defer { self?.timerTaskDidExit(token: token) }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: timerInterval)
                } catch {
                    return
                }
                guard let self, isForeground, canRequestAccountData else { return }
                await refreshDue()
            }
        }
    }

    func stopTimer() {
        timerTask?.cancel()
        timerTask = nil
        timerTaskToken = nil
    }

    func timerTaskDidExit(token: UUID) {
        // A loop started after this one owns the property now; leave it alone.
        guard timerTaskToken == token else { return }
        timerTask = nil
        timerTaskToken = nil
    }

    /// The one place that drops in-flight endpoint requests. Both site switches
    /// and sign-out need it, and the task handles must be nil'd as well as
    /// cancelled so the next trigger does not join a doomed request.
    func cancelInFlightRequests() {
        liveTask?.cancel()
        powerTask?.cancel()
        billTask?.cancel()
        liveTask = nil
        liveTaskImportsHistory = false
        manualRefreshCount = 0
        powerTask = nil
        billTask = nil
    }
}
