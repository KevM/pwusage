import Foundation

/// Copy and availability rules shared by the sheet, toolbar and native tests.
enum BatteryHoldPresentation {
    static func canStart(state: BatteryHoldState, stateOfCharge: Double?, hasTariff: Bool, at now: Date) -> Bool {
        guard let stateOfCharge, BatteryHoldReservePlan.make(stateOfCharge: stateOfCharge) != nil else { return false }
        return hasTariff && canControl(state: state, at: now) && state.response?.hold == nil
    }

    static func canControl(state: BatteryHoldState, at now: Date) -> Bool {
        state.statusIsCurrent(at: now) && !state.isBusy && state.failure != .needsReauthentication
    }

    static func reserveText(_ reserve: Int) -> String {
        reserve == 100 ? "100% (max)" : "\(reserve)%"
    }

    static func restorationText(_ hold: BatteryHold, timeZone: String, at now: Date) -> String {
        if now >= hold.safetyExpiresAt {
            return "Waiting to restore your backup reserve automatically. You can also turn off Battery Saver."
        }
        let zone = TimeZone(identifier: timeZone) ?? .current
        var format = Date.FormatStyle.dateTime.month(.abbreviated).day().hour().minute()
        format.timeZone = zone
        let deadline = hold.safetyExpiresAt.formatted(format)
        if hold.mode == .timer { return "Scheduled to restore \(deadline). The timer runs for the full duration." }
        return "Restores your backup reserve automatically when the job finishes."
    }

    static func safetyText(_ hold: BatteryHold, timeZone: String) -> String {
        var format = Date.FormatStyle.dateTime.month(.abbreviated).day().hour().minute()
        format.timeZone = TimeZone(identifier: timeZone) ?? .current
        return "As a safety limit, your original reserve is restored after eight hours (\(hold.safetyExpiresAt.formatted(format)))."
    }

    /// Apple ends a standard Live Activity after eight hours, and this app never restarts one to get around that.
    static func liveActivityLimitText(_ hold: BatteryHold, at now: Date) -> String? {
        guard hold.safetyExpiresAt.timeIntervalSince(now) > BatteryHoldActivityAttributes.displayLimit else { return nil }
        return "iOS shows a Live Activity for up to eight hours. Battery Saver runs longer, so open pwusage or the Battery Saver control to check it after that."
    }

    static func noticeText(_ notice: BatteryHold) -> String {
        if let reserve = notice.cancelledObservedReserve {
            return "Battery Saver stopped. Your reserve was changed outside pwusage to \(reserve)%, so we left it as-is."
        }
        return "Battery Saver stopped. Your reserve was changed outside pwusage, so we left it as-is."
    }

    static func restoreConfirmationText(originalReserve: Int) -> String {
        "Turning off Battery Saver sets your backup reserve back to \(originalReserve)%. This replaces any reserve changes you made in Tesla while Battery Saver was on."
    }

    static func monitoringText(_ monitoring: BatteryHoldMonitoring, at now: Date) -> String {
        if monitoring.phase == .checkFailed {
            return "The last check failed. Battery Saver is still on."
        }
        if monitoring.phase != .timer && monitoring.phase != .restoring,
           monitoring.sampledAt.map({ now.timeIntervalSince($0) > 20 * 60 }) ?? true {
            return "Waiting for updated usage data. Battery Saver is still on."
        }
        switch monitoring.phase {
        case .watching: return "Waiting for a job to finish."
        case .loadRunning:
            if let watts = monitoring.estimatedLoadW, watts.isFinite, watts >= 0 {
                let power = (watts / 1000).formatted(.number.precision(.fractionLength(0 ... 1)))
                return "About \(power) kW above your starting home use. Waiting for the job to finish."
            }
            return "Waiting for higher home use to end."
        case .confirmingEnd: return "Home use has dropped. Checking that it stays low."
        case .waitingForData: return "Waiting for updated usage data. Battery Saver is still on."
        case .restoring: return "The job looks finished, so Battery Saver is turning off. Waiting for Tesla to confirm."
        case .timer: return "On until the scheduled stop time."
        case .checkFailed: return "The last check failed. Battery Saver is still on."
        }
    }

    static func loadSummary(_ monitoring: BatteryHoldMonitoring, at now: Date) -> String? {
        guard monitoring.phase == .loadRunning,
              let sampledAt = monitoring.sampledAt, now.timeIntervalSince(sampledAt) <= 20 * 60,
              let watts = monitoring.estimatedLoadW, watts.isFinite, watts >= 0 else { return nil }
        let power = (watts / 1000).formatted(.number.precision(.fractionLength(0 ... 1)))
        return "Detected job: about \(power) kW"
    }

    static func nextCheckText(_ monitoring: BatteryHoldMonitoring, at now: Date) -> String {
        let remaining = monitoring.nextCheckAt.timeIntervalSince(now)
        guard remaining > 0 else { return "Waiting for the next check" }
        let minutes = Int(ceil(remaining / 60))
        return "Checking again in \(minutes) \(minutes == 1 ? "minute" : "minutes")"
    }

    static func toolbarReserve(state: BatteryHoldState, at now: Date) -> String? {
        guard state.statusIsCurrent(at: now), let hold = state.response?.hold else { return nil }
        return "\(hold.targetReserve)%"
    }

    static func toolbarAccessibilityLabel(state: BatteryHoldState, at now: Date) -> String {
        guard state.statusIsCurrent(at: now) else { return "Battery Saver, status unknown" }
        if let reserve = toolbarReserve(state: state, at: now) {
            return "Battery Saver on, saving your Powerwall at \(reserve). Open Battery Saver."
        }
        return "Battery Saver. Open Battery Saver."
    }
}
