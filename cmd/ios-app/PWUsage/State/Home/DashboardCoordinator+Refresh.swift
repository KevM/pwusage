import Combine
import Foundation

extension DashboardCoordinator {
    /// Called by the foreground timer and lifecycle events. Missed intervals collapse to one request.
    func refreshDue() async {
        await refreshAll(trigger: .scheduled)
    }

    /// Refreshes live power readings followed by bill estimates.
    func refreshAll(trigger: RefreshTrigger) async {
        guard canRequestAccountData else { return }
        if trigger == .scheduled {
            guard isForeground else { return }
        }
        let generation = siteGeneration
        defer { if generation == siteGeneration, canRequestAccountData { refreshSettled = true } }
        await refreshPower(force: trigger == .userGesture)
        guard canStillRefresh(trigger: trigger, generation: generation) else { return }
        let requestTime = now()

        startLiveTaskIfNeeded(trigger: trigger, generation: generation)
        // The live endpoint may first import stale energy history. Wait for it
        // before asking the bill endpoint to calculate from that history.
        let billAttemptsBeforeWait = billAttempts
        guard await waitForRequest(liveTask) else { return }
        guard canStillRefresh(trigger: trigger, generation: generation) else { return }

        let waitsForBill = await reconcileBillAfterLive(
            trigger: trigger, requestTime: requestTime,
            billAttemptsBeforeWait: billAttemptsBeforeWait, generation: generation
        )
        guard waitsForBill else { return }
        _ = await waitForRequest(billTask)
    }

    private func startLiveTaskIfNeeded(trigger: RefreshTrigger, generation: Int) {
        guard liveTask == nil else { return }
        let interval = usesLivePowerEndpoint ? Self.summaryInterval : Self.liveInterval
        guard trigger == .userGesture
            || liveCadence.isDue(at: cadenceNow(), interval: .seconds(interval)) else { return }
        let siteID = selectedSiteID
        liveTask = Task { await performLive(siteID: siteID, generation: generation) }
    }

    /// Reconciles the bill request against the live import that just ran. Returns false
    /// when the caller must stop without waiting on the bill task.
    private func reconcileBillAfterLive(
        trigger: RefreshTrigger,
        requestTime: Date,
        billAttemptsBeforeWait: Int,
        generation: Int
    ) async -> Bool {
        if billAttempts == billAttemptsBeforeWait {
            launchBillTaskIfNeeded(trigger: trigger, requestTime: requestTime,
                                   generation: generation, followsLive: true)
        } else if !latestBillAttemptFollowedLive {
            // Another caller attempted the bill while live was still importing
            // history, so that bill is stale. Let it finish, then recalculate
            // once, whichever waiting refresh gets here first.
            _ = await waitForRequest(billTask)
            guard canStillRefresh(trigger: trigger, generation: generation) else { return false }
            if !latestBillAttemptFollowedLive {
                launchBillTaskIfNeeded(trigger: .userGesture, requestTime: now(),
                                       generation: generation, followsLive: true)
            }
        }
        // Otherwise a bill already followed this live request. Comparing its
        // newer attempt with the pre-wait time would read as a backwards clock
        // and send a duplicate request.
        return true
    }

    func canStillRefresh(trigger: RefreshTrigger, generation: Int) -> Bool {
        // A cancelled caller (a refreshable view going away, a timer loop
        // stopping) must not start the next leg of the refresh.
        guard canRequestAccountData, generation == siteGeneration, !Task.isCancelled else { return false }
        return trigger != .scheduled || isForeground
    }

    /// Refreshes the bill estimate, subject to the trigger's cadence.
    func refreshBill(trigger: RefreshTrigger) async {
        guard canRequestAccountData else { return }
        if trigger == .scheduled {
            guard isForeground else { return }
        }
        let requestTime = now()
        let generation = siteGeneration

        launchBillTaskIfNeeded(trigger: trigger, requestTime: requestTime,
                               generation: generation, followsLive: liveTask == nil)

        _ = await waitForRequest(billTask)
    }

    func launchBillTaskIfNeeded(trigger: RefreshTrigger, requestTime: Date, generation: Int, followsLive: Bool) {
        guard billTask == nil else { return }
        let cadence = cadenceNow()
        let due: Bool
        switch trigger {
        case .userGesture: due = true
        case .screenAppearance:
            due = billCadence.isDue(at: cadence, interval: .seconds(Self.billMinimumInterval))
        case .scheduled:
            due = billCadence.isDue(at: cadence, interval: .seconds(Self.billInterval))
                || (energyDataIsAgingForForecast(at: requestTime)
                    && billCadence.isDue(at: cadence, interval: .seconds(Self.billMinimumInterval)))
        }
        guard due else { return }
        billAttempts += 1
        latestBillAttemptFollowedLive = followsLive
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
        let due = powerCadence.isDue(at: cadenceNow(), interval: .seconds(Self.livePowerInterval))
        guard force || due else { return }
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

    private func handlePowerFailure(_ error: Error, generation: Int) {
        guard !isCancellation(error) else { return }
        guard generation == siteGeneration, canRequestAccountData else { return }
        recordAttempt(.power)
        if error as? PWUsageAPIError == .signInRequired {
            authenticationInvalidated()
            isForeground = false
            stopTimer()
        } else if let rejected = error as? PWUsageAPIError,
                  case .requestRejected(let statusCode, _) = rejected, statusCode == 404 {
            // An older server can still serve the combined endpoint.
            livePowerEndpointAvailable = false
            power.isUnavailable = false
        } else {
            if error as? PWUsageAPIError
                == .requestRejected(statusCode: 409, message: "TESLA_CONNECTION_REQUIRED") {
                requiresTeslaReconnect = true
                batteryHold.failure = .needsReauthentication
            }
            power.isUnavailable = true
        }
    }

    func performLive(siteID: String, generation: Int) async {
        defer {
            if generation == siteGeneration { liveTask = nil }
        }
        do {
            let response = try await api.fetchLive(siteID: siteID)
            guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return }
            recordAttempt(.live)
            live.response = response
            let successTime = now()
            live.lastSuccess = successTime
            live.isRestored = false
            if api is any MobileLivePowerDataAPI,
               let source = response.sources.liveStatusAt,
               source >= (power.response?.sources.liveStatusAt ?? .distantPast) {
                power.response = MobileLivePowerResponse(snapshot: response)
                power.isUnavailable = false
            }
            let snapshot = power.response.map { MobileLiveResponse(snapshot: response, power: $0) } ?? response
            cache?.storeLive(snapshot, at: successTime)
            live.isUnavailable = false
            teslaConnectionRestored()
        } catch {
            // A cancelled fetch is not a failed one: an abandoned pull-to-refresh,
            // a site switch or a background transition must leave live state alone.
            guard !isCancellation(error) else { return }
            guard generation == siteGeneration else { return }
            recordAttempt(.live)
            handle(error, generation: generation, endpoint: .live)
        }
    }

    func performBill(siteID: String, generation: Int) async {
        defer {
            if generation == siteGeneration { billTask = nil }
        }
        do {
            let response = try await api.fetchBill(siteID: siteID)
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
            guard !isCancellation(error) else { return }
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

    private func teslaConnectionRestored() {
        guard !requiresTeslaCommandReauthorization else { return }
        if requiresTeslaReconnect, batteryHold.failure == .needsReauthentication {
            batteryHold.failure = nil
        }
        requiresTeslaReconnect = false
    }

    /// Records a completed attempt against both clocks. The wall-clock stamp is
    /// kept for diagnostics; `EndpointCadence` is the one that decides due-ness.
    /// Callers record after a request finishes and never for a cancelled one, so
    /// an abandoned request cannot consume a retry window.
    private func recordAttempt(_ endpoint: Endpoint) {
        let attempt = now()
        let cadence = cadenceNow()
        switch endpoint {
        case .live:
            live.lastAttempt = attempt
            liveCadence.recordAttempt(at: cadence)
        case .bill:
            bill.lastAttempt = attempt
            billCadence.recordAttempt(at: cadence)
        case .power:
            power.lastAttempt = attempt
            powerCadence.recordAttempt(at: cadence)
        }
    }

    func resetRequestCadence() {
        liveCadence.reset()
        powerCadence.reset()
        billCadence.reset()
    }

    /// Awaits an in-flight request and reports whether the caller is still active.
    /// `refreshAll` is non-throwing, so a cancelled caller must stop it explicitly
    /// between legs rather than by interrupting the `Task.value` await.
    private func waitForRequest(_ task: Task<Void, Never>?) async -> Bool {
        guard let task else { return !Task.isCancelled }
        await task.value
        return !Task.isCancelled
    }

    private func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
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
        powerTask = nil
        billTask = nil
    }
}
