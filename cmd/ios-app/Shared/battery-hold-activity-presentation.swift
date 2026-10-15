import Foundation

/// Copy for the battery hold Live Activity. Shows only what the server
/// confirmed: absolute check and deadline times rather than live-counting
/// timers, "home load" rather than any claim about a car, and an explicit
/// overdue state once updates stop arriving.
enum BatteryHoldActivityPresentation {
    typealias State = BatteryHoldActivityAttributes.ContentState

    static func isRestoring(_ state: State) -> Bool {
        state.status == .active && (state.phase == .restoring || state.restoreReason != nil)
    }

    static func headline(_ state: State) -> String {
        switch state.status {
        case .active:
            isRestoring(state) ? "Restoring \(state.originalReserve)% reserve" : "Holding at \(state.targetReserve)%"
        case .restored: "Reserve restored to \(state.originalReserve)%"
        case .cancelled: "Battery hold cancelled"
        case .ended, .unknown: "Battery hold ended"
        }
    }

    static func detail(_ state: State, isStale: Bool) -> String {
        switch state.status {
        case .restored:
            switch state.restoreReason {
            case .loadEnded: return "Home load finished."
            case .manual: return "Stopped in pwusage."
            case .safetyTimeout: return "Eight-hour safety limit reached."
            case .timerElapsed: return "Scheduled stop time reached."
            default: return "The hold has finished."
            }
        case .cancelled:
            if let reserve = state.cancelledObservedReserve {
                return "Reserve changed outside pwusage to \(reserve)%, so it was left as-is."
            }
            return "Reserve changed outside pwusage, so it was left as-is."
        case .ended, .unknown:
            return "Open pwusage to see how it finished."
        case .active:
            break
        }
        if isStale { return "Update overdue. Open pwusage for the current status." }
        if isRestoring(state) { return "Restore requested. Waiting for Tesla to confirm." }
        switch state.phase {
        case nil: return state.mode == .timer ? "Holding until the scheduled stop time." : "Waiting for the first home load check."
        case .watching: return "Watching home load."
        case .loadRunning:
            if let watts = state.estimatedLoadW, watts.isFinite, watts >= 0 {
                let power = (watts / 1000).formatted(.number.precision(.fractionLength(0...1)))
                return "Home load about \(power) kW above the start."
            }
            return "Home load is running."
        case .confirmingEnd: return "Home load dropped. Confirming it stays low."
        case .waitingForData: return "Waiting for usage data. The hold is still active."
        case .checkFailed: return "The last check failed. The hold is still active."
        case .timer: return "Holding until the scheduled stop time."
        case .restoring: return "Restore requested. Waiting for Tesla to confirm."
        case .unknown: return "The hold is active."
        }
    }

    /// The fixed restore time, or the Auto safety deadline. Reaching it is not proof of restoration.
    static func deadline(_ state: State, timeZone: TimeZone, now: Date) -> String? {
        switch state.status {
        case .active:
            let time = clock(state.safetyExpiresAt, timeZone: timeZone, now: now)
            return state.mode == .timer ? "Stops \(time)" : "Safety stop by \(time)"
        case .restored, .cancelled:
            return state.endedAt.map { "Ended \(clock($0, timeZone: timeZone, now: now))" }
        case .ended, .unknown:
            return nil
        }
    }

    /// When the server last checked. An absolute time stays honest on a Lock Screen that isn't redrawn.
    static func checked(_ state: State, timeZone: TimeZone, now: Date) -> String? {
        guard state.status == .active, let checkedAt = state.checkedAt else { return nil }
        return "Checked \(clock(checkedAt, timeZone: timeZone, now: now))"
    }

    /// Apple ends a standard Live Activity after eight hours; a longer fixed hold keeps running.
    static func displayLimitNote(_ attributes: BatteryHoldActivityAttributes, _ state: State, now: Date) -> String? {
        let displayEnd = attributes.activityStartedAt.addingTimeInterval(BatteryHoldActivityAttributes.displayLimit)
        guard state.status == .active, state.safetyExpiresAt > displayEnd else { return nil }
        let zone = timeZone(attributes)
        return "iOS ends this display \(clock(displayEnd, timeZone: zone, now: now)). The hold continues; check pwusage."
    }

    static func timeZone(_ attributes: BatteryHoldActivityAttributes) -> TimeZone {
        TimeZone(identifier: attributes.timeZoneIdentifier) ?? .current
    }

    static func reserveText(_ state: State) -> String {
        isRestoring(state) || state.isFinal ? "\(state.originalReserve)%" : "\(state.targetReserve)%"
    }

    static func clock(_ date: Date, timeZone: TimeZone, now: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var format = calendar.isDate(date, inSameDayAs: now)
            ? Date.FormatStyle.dateTime.hour().minute()
            : Date.FormatStyle.dateTime.weekday(.abbreviated).hour().minute()
        format.timeZone = timeZone
        return date.formatted(format)
    }
}
