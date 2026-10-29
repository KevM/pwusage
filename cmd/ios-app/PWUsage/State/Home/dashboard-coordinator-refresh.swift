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
        let interval = usesLivePowerEndpoint ? Self.summaryInterval : Self.liveInterval

        if liveTask == nil {
            if trigger == .userGesture
                || isDue(lastAttempt: live.lastAttempt, interval: interval, at: requestTime) {
                live.lastAttempt = requestTime
                let siteID = selectedSiteID
                liveTask = Task { await performLive(siteID: siteID, generation: generation) }
            }
        }
        // The live endpoint may first import stale energy history. Wait for it
        // before asking the bill endpoint to calculate from that history.
        let billAttemptsBeforeWait = billAttempts
        await liveTask?.value
        guard canStillRefresh(trigger: trigger, generation: generation) else { return }

        if billAttempts == billAttemptsBeforeWait {
            launchBillTaskIfNeeded(trigger: trigger, requestTime: requestTime, generation: generation, followsLive: true)
        } else if !latestBillAttemptFollowedLive {
            // Another caller attempted the bill while live was still importing
            // history, so that bill is stale. Let it finish, then recalculate
            // once, whichever waiting refresh gets here first.
            await billTask?.value
            guard canStillRefresh(trigger: trigger, generation: generation) else { return }
            if !latestBillAttemptFollowedLive {
                launchBillTaskIfNeeded(trigger: .userGesture, requestTime: now(), generation: generation, followsLive: true)
            }
        }
        // Otherwise a bill already followed this live request. Comparing its
        // newer attempt with the pre-wait time would read as a backwards clock
        // and send a duplicate request.

        await billTask?.value
    }

    func canStillRefresh(trigger: RefreshTrigger, generation: Int) -> Bool {
        guard canRequestAccountData, generation == siteGeneration else { return false }
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

        launchBillTaskIfNeeded(trigger: trigger, requestTime: requestTime, generation: generation, followsLive: liveTask == nil)

        await billTask?.value
    }

    func launchBillTaskIfNeeded(trigger: RefreshTrigger, requestTime: Date, generation: Int, followsLive: Bool) {
        guard billTask == nil else { return }
        let due: Bool
        switch trigger {
        case .userGesture: due = true
        case .screenAppearance:
            due = isDue(lastAttempt: bill.lastAttempt, interval: Self.billMinimumInterval, at: requestTime)
        case .scheduled:
            due = isDue(lastAttempt: bill.lastAttempt, interval: Self.billInterval, at: requestTime)
                || (energyDataIsAgingForForecast(at: requestTime)
                    && isDue(lastAttempt: bill.lastAttempt, interval: Self.billMinimumInterval, at: requestTime))
        }
        guard due else { return }
        bill.lastAttempt = requestTime
        billAttempts += 1
        latestBillAttemptFollowedLive = followsLive
        let siteID = selectedSiteID
        billTask = Task { await performBill(siteID: siteID, generation: generation) }
    }

    func isDue(lastAttempt: Date?, interval: TimeInterval, at date: Date) -> Bool {
        guard let lastAttempt else { return true }
        let elapsed = date.timeIntervalSince(lastAttempt)
        // A negative elapsed time means the device clock moved backwards, so real
        // elapsed time is unknown. Treat it as due: a spurious poll costs one
        // request, while stalling freezes live and bill data indefinitely with no
        // error and nothing on screen to explain it.
        guard elapsed.isFinite else { return true }
        return elapsed < 0 || elapsed >= interval
    }

    /// Solcast is set up and the bill's energy data is nearly too old for the forecast comparison.
    func energyDataIsAgingForForecast(at date: Date) -> Bool {
        guard solarForecastConnection == .ready,
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
            await powerTask.value
            return
        }
        let due = isDue(lastAttempt: power.lastAttempt, interval: Self.livePowerInterval, at: now())
        guard force || due else { return }
        power.lastAttempt = now()
        let generation = siteGeneration
        let siteID = selectedSiteID
        powerTask = Task {
            defer { if generation == siteGeneration { powerTask = nil } }
            do {
                let response = try await powerAPI.fetchLivePower(siteID: siteID).validating(siteID: siteID)
                guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return }
                power.response = response
                power.lastSuccess = now()
                power.isUnavailable = false
                teslaConnectionRestored()
            } catch {
                guard generation == siteGeneration, canRequestAccountData else { return }
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
        }
        await powerTask?.value
    }

    func performLive(siteID: String, generation: Int) async {
        defer {
            if generation == siteGeneration { liveTask = nil }
        }
        do {
            let response = try await api.fetchLive(siteID: siteID)
            guard generation == siteGeneration, canRequestAccountData else { return }
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
            live.unavailableStatusCode = nil
        } catch {
            handle(error, generation: generation, endpoint: .live)
        }
    }

    func performBill(siteID: String, generation: Int) async {
        defer {
            if generation == siteGeneration { billTask = nil }
        }
        do {
            let response = try await api.fetchBill(siteID: siteID)
            guard generation == siteGeneration, canRequestAccountData else { return }
            bill.response = response
            billSuccessGeneration += 1
            let successTime = now()
            bill.lastSuccess = successTime
            bill.isRestored = false
            cache?.storeBill(response, at: successTime)
            bill.isUnavailable = false
            bill.unavailableStatusCode = nil
        } catch {
            handle(error, generation: generation, endpoint: .bill)
        }
    }

    enum Endpoint { case live, bill }

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
            live.unavailableStatusCode = (error as? PWUsageAPIError).flatMap {
                guard case let .recoverableServerError(statusCode) = $0 else { return nil }
                return statusCode
            }
        case .bill:
            bill.isUnavailable = true
            bill.unavailableStatusCode = (error as? PWUsageAPIError).flatMap {
                guard case let .recoverableServerError(statusCode) = $0 else { return nil }
                return statusCode
            }
        }
    }

    private func teslaConnectionRestored() {
        if requiresTeslaReconnect, batteryHold.failure == .needsReauthentication {
            batteryHold.failure = nil
        }
        requiresTeslaReconnect = false
    }

    func startTimer() {
        guard timerTask == nil, let timerInterval else { return }
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: timerInterval) }
                catch { return }
                guard let self, self.isForeground, self.canRequestAccountData else { return }
                await self.refreshDue()
            }
        }
    }

    func stopTimer() {
        timerTask?.cancel()
        timerTask = nil
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
