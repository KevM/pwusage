import Foundation

extension DashboardCoordinator {
    func performLive(siteID: String, generation: Int, importsHistory: Bool = false) async {
        defer {
            if generation == siteGeneration {
                liveTask = nil
                liveTaskImportsHistory = false
            }
        }
        do {
            let response: MobileLiveResponse
            if let conditionalAPI = api as? any MobileConditionalDashboardDataAPI {
                response = try await conditionalAPI.fetchLive(
                    siteID: siteID, refresh: importsHistory, historyCheck: false, reusing: reusableLiveSummary
                )
                guard canPublishLive(generation: generation) else { return }
                publishLive(response)
                if response.historyRefresh?.status == .pending {
                    await checkPendingHistory(using: conditionalAPI, siteID: siteID, generation: generation)
                }
            } else {
                response = try await api.fetchLive(siteID: siteID, refresh: importsHistory)
                guard canPublishLive(generation: generation) else { return }
                publishLive(response)
            }
            guard canPublishLive(generation: generation) else { return }
            recordAttempt(.live)
        } catch {
            // This task's own cancellation is not a failure, whatever error the
            // transport surfaced. A cancellation the app did not cause is real.
            guard !isAbandonedRequest() else { return }
            guard generation == siteGeneration else { return }
            recordAttempt(.live)
            handle(error, generation: generation, endpoint: .live)
        }
    }

    private var reusableLiveSummary: MobileLiveResponse? {
        guard usesLivePowerEndpoint, power.response != nil, !power.isUnavailable else { return nil }
        return live.response
    }

    private func canPublishLive(generation: Int) -> Bool {
        generation == siteGeneration && canRequestAccountData && !Task.isCancelled
    }

    private func checkPendingHistory(
        using api: any MobileConditionalDashboardDataAPI, siteID: String, generation: Int
    ) async {
        for delay in pendingHistoryCheckDelays {
            guard isForeground else { return }
            do {
                // Give the active writer time to finish, then make a read-only check.
                try await Task.sleep(for: delay)
                guard isForeground, canPublishLive(generation: generation) else { return }
                let response = try await api.fetchLive(
                    siteID: siteID, refresh: false, historyCheck: true, reusing: reusableLiveSummary
                )
                guard isForeground, canPublishLive(generation: generation) else { return }
                publishLive(response)
                guard response.historyRefresh?.status == .pending else { return }
            } catch {
                handlePendingCheckFailure(error, generation: generation)
                return
            }
        }
    }

    private func handlePendingCheckFailure(_ error: any Error, generation: Int) {
        guard isForeground, canPublishLive(generation: generation),
              let failure = error as? PWUsageAPIError else { return }
        // The pending response is still usable on transient failure.
        switch failure {
        case .signInRequired, .requestRejected(statusCode: 409, message: "TESLA_CONNECTION_REQUIRED"):
            handle(failure, generation: generation, endpoint: .live)
        default: break
        }
    }

    private func publishLive(_ response: MobileLiveResponse) {
        if historyMayHaveChanged(in: response) { historyGeneration += 1 }
        live.response = response
        let successTime = now()
        live.lastSuccess = successTime
        live.isRestored = false
        if api is any MobileLivePowerDataAPI,
           let source = response.sources.liveStatusAt,
           source >= (power.response?.sources.liveStatusAt ?? .distantPast) {
            power.response = MobileLivePowerResponse(snapshot: response)
            power.isUnavailable = false
            power.freshReadingWait = nil
        }
        let snapshot = power.response.map { MobileLiveResponse(snapshot: response, power: $0) } ?? response
        cache?.storeLive(snapshot, at: successTime)
        live.isUnavailable = false
        live.freshReadingWait = nil
        teslaConnectionRestored()
    }

    private func historyMayHaveChanged(in response: MobileLiveResponse) -> Bool {
        // Older servers omit the outcome. Preserve the existing follow-up for them.
        guard let status = response.historyRefresh?.status else { return true }
        if status == .changed { return true }
        guard let previous = live.response else { return false }
        return previous.sources.energyDataThrough != response.sources.energyDataThrough
            || (previous.historyRevision != nil && previous.historyRevision != response.historyRevision)
    }
}
