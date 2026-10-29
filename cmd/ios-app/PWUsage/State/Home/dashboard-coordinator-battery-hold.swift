import Combine
import Foundation

extension DashboardCoordinator {
    /// Reads database-backed hold status without making a Tesla request.
    func refreshBatteryHold(force: Bool = true) async {
        guard canRequestAccountData, !Task.isCancelled, !batteryHold.isBusy,
              let holdAPI = api as? any MobileBatteryHoldDataAPI else { return }
        if !force, batteryHold.isCurrent, let fetchedAt = batteryHold.fetchedAt,
           (0 ..< 60).contains(now().timeIntervalSince(fetchedAt)) { return }
        let generation = siteGeneration
        let siteID = selectedSiteID
        batteryHold.isRefreshing = true
        defer { if generation == siteGeneration { batteryHold.isRefreshing = false } }
        do {
            let response = try await holdAPI.fetchBatteryHold(siteID: siteID).validating(siteID: siteID)
            guard generation == siteGeneration, canRequestAccountData, !Task.isCancelled else { return }
            batteryHold.response = response
            batteryHold.isCurrent = true
            batteryHold.fetchedAt = now()
            reportBatteryHold(.refreshed(response), siteID: siteID)
            // A DB read cannot tell whether the Tesla token has command permission.
            if batteryHold.failure != .needsReauthentication && batteryHold.failure != .needsChoice {
                batteryHold.failure = nil
            }
        } catch {
            guard generation == siteGeneration, !Task.isCancelled else { return }
            batteryHold.isCurrent = false
            handleBatteryHoldError(error)
        }
    }

    func sendBatteryHoldCommand(_ command: BatteryHoldCommand) async {
        guard canRequestAccountData, !requiresTeslaReconnect, !Task.isCancelled, !batteryHold.isBusy,
              batteryHold.statusIsCurrent(at: now()),
              let holdAPI = api as? any MobileBatteryHoldDataAPI else { return }
        if case .park(let choice) = command, !choice.isValid { return }
        let generation = siteGeneration
        let siteID = selectedSiteID
        let previousHoldID = batteryHold.response?.hold?.id
        batteryHold.isSubmitting = true
        batteryHold.failure = nil
        defer { if generation == siteGeneration { batteryHold.isSubmitting = false } }
        do {
            let result = try await holdAPI.sendBatteryHoldCommand(siteID: siteID, command: command)
                .validating(siteID: siteID, command: command)
            guard generation == siteGeneration, canRequestAccountData else { return }
            batteryHold.requiresReserveChoice = false
            // Once a command succeeds, the old snapshot is no longer authoritative.
            // Reconcile from the DB while keeping duplicate commands disabled.
            batteryHold.isCurrent = false
            if case .park = command {
                batteryHold.response = .init(hold: result.hold, notice: batteryHold.response?.notice)
                if let hold = result.hold { reportBatteryHold(.started(hold), siteID: siteID) }
            } else if case .restore = command {
                batteryHold.response = .init(hold: nil, notice: batteryHold.response?.notice)
                if result.status == .ok, let previousHoldID { reportBatteryHold(.stopped(holdID: previousHoldID), siteID: siteID) }
            }
            let response = try await holdAPI.fetchBatteryHold(siteID: siteID).validating(siteID: siteID)
            guard generation == siteGeneration, canRequestAccountData else { return }
            batteryHold.response = response
            batteryHold.isCurrent = true
            batteryHold.fetchedAt = now()
            reportBatteryHold(.refreshed(response), siteID: siteID)
        } catch {
            guard generation == siteGeneration else { return }
            handleBatteryHoldError(error)
        }
    }

    func reportBatteryHold(_ confirmation: BatteryHoldConfirmation, siteID: String) {
        let timeZone = live.response?.site.timezone ?? bill.response?.site.timezone
        batteryHoldActivityObserver?.batteryHoldConfirmed(confirmation, siteID: siteID, timeZone: timeZone)
    }

    func batteryHoldStateOfCharge(at date: Date) -> Double? {
        if let response = power.response, response.siteID == selectedSiteID, !power.isUnavailable {
            return MobileLiveResponse.validatedStateOfCharge(
                response.stateOfCharge, takenAt: response.sources.stateOfChargeAt, now: date
            )
        }
        guard !live.isUnavailable, let response = live.response,
              response.site.id == selectedSiteID else { return nil }
        return MobileLiveResponse.validatedStateOfCharge(response.stateOfCharge, takenAt: response.sources.stateOfChargeAt, now: date)
    }

    func handleBatteryHoldError(_ error: any Error) {
        if error as? PWUsageAPIError == .signInRequired {
            authenticationInvalidated()
            isForeground = false
            stopTimer()
            return
        }
        switch error as? PWUsageAPIError {
        case .requestRejected(_, "needs_reauth"):
            batteryHold.failure = .needsReauthentication
        case .requestRejected(_, "reserve_sync_pending"):
            batteryHold.failure = .reserveSyncPending
        case .requestRejected(_, "needs_choice"):
            batteryHold.requiresReserveChoice = true
            batteryHold.failure = .needsChoice
        case .requestRejected(_, "no_soc"):
            batteryHold.failure = .noStateOfCharge
        case .requestRejected(_, "no_active_hold"):
            batteryHold.isCurrent = false
            batteryHold.failure = .noActiveHold
        default:
            // A failed command may have reached Tesla. Never blindly retry it.
            batteryHold.isCurrent = false
            batteryHold.failure = .unavailable
        }
    }
}
