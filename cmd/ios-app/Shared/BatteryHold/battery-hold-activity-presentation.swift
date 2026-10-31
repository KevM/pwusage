import Foundation

/// Copy for the battery hold Live Activity, kept glanceable: a headline, one
/// line of figures, and a status line only when something needs saying. Shows
/// only what the server confirmed: absolute deadline times rather than
/// live-counting timers, "home use" rather than any claim about a car, and an
/// explicit overdue state once updates stop arriving.
enum BatteryHoldActivityPresentation {
    typealias State = BatteryHoldActivityAttributes.ContentState

    /// The pwusage glyph (asset catalog, template). Control Center keeps the
    /// system symbol in `BatteryHoldControlIdentity.symbolName`: it caches control artwork.
    static let glyphName = "pwusage-glyph"

    /// Auto's safety stop is shown only this close to it; earlier it rarely matters.
    static let safetyStopNotice: TimeInterval = 60 * 60

    /// One short line under the figures. Warnings are drawn in orange with a symbol.
    struct Status: Equatable {
        let text: String
        let isWarning: Bool
    }

    /// The live charge as a whole number, shown in the fill's green. The fill uses the unrounded value.
    static func batteryText(_ state: State) -> String? {
        guard let percent = state.batteryPercent, percent.isFinite else { return nil }
        return "\(Int(min(max(percent, 0), 100).rounded()))%"
    }

    /// The current home load from the last check. The overdue state covers its age.
    static func homeLoadText(_ state: State) -> String? {
        guard state.status == .active, let home = state.homeLoadW, home.isFinite else { return nil }
        return kilowatts(home)
    }

    /// The peak since the hold started, only when it reads higher than the current load.
    static func peakText(_ state: State) -> String? {
        guard let home = homeLoadText(state), let peak = state.peakLoadW, peak.isFinite,
              peak > (state.homeLoadW ?? 0), kilowatts(peak) != home else { return nil }
        return "peak \(kilowatts(peak))"
    }

    static func isRestoring(_ state: State) -> Bool {
        state.status == .active && (state.phase == .restoring || state.restoreReason != nil)
    }

    static func headline(_ state: State) -> String {
        switch state.status {
        case .active:
            isRestoring(state) ? "Restoring \(state.originalReserve)% backup reserve" : "Saving your Powerwall at \(state.targetReserve)%"
        case .restored: "Backup reserve restored to \(state.originalReserve)%"
        case .cancelled: "Battery Saver stopped"
        case .ended, .unknown: "Battery Saver ended"
        }
    }

    /// The status line, or nil when the headline and figures already say it all.
    /// One line: a warning wins over a transition, which wins over a deadline.
    static func status(_ attributes: BatteryHoldActivityAttributes, _ state: State, isStale: Bool, now: Date) -> Status? {
        if let nonActive = nonActiveStatus(state) {
            return nonActive
        }
        return activeStatus(attributes, state, isStale: isStale, now: now)
    }

    private static func nonActiveStatus(_ state: State) -> Status? {
        let info = { (text: String) in Status(text: text, isWarning: false) }
        switch state.status {
        case .restored:
            return restoredStatus(state.restoreReason)
        case .cancelled:
            let detail = state.cancelledObservedReserve.map { "Backup reserve set to \($0)% outside pwusage" }
                ?? "Backup reserve changed outside pwusage"
            return info(detail)
        case .ended, .unknown:
            return info("Open pwusage for details")
        case .active:
            return nil
        }
    }

    private static func restoredStatus(_ reason: State.RestoreReason?) -> Status? {
        let info = { (text: String) in Status(text: text, isWarning: false) }
        switch reason {
        case .loadEnded: return info("Home use dropped")
        case .noLoadDetected: return info("No job detected")
        case .manual: return info("Stopped in pwusage")
        case .safetyTimeout: return info("8-hour safety limit")
        case .timerElapsed: return info("Stop time reached")
        default: return nil
        }
    }

    private static func activeStatus(
        _ attributes: BatteryHoldActivityAttributes,
        _ state: State,
        isStale: Bool,
        now: Date
    ) -> Status? {
        let info = { (text: String) in Status(text: text, isWarning: false) }
        if isStale { return Status(text: "Update overdue", isWarning: true) }
        if isRestoring(state) { return info("Confirming with Tesla") }
        switch state.phase {
        case .waitingForData: return Status(text: "Usage data delayed", isWarning: true)
        case .checkFailed: return Status(text: "Last check failed", isWarning: true)
        case .confirmingEnd: return info("Home use dropped, confirming")
        case nil where state.mode == .auto: return info("Waiting for first check")
        default: break
        }
        return deadline(attributes, state, now: now).map(info)
    }

    /// A fixed hold's stop time is its plan, so it always shows. Auto's safety stop
    /// rarely matters early, so it shows only in the last hour. Reaching either is
    /// not proof of restoration.
    private static func deadline(_ attributes: BatteryHoldActivityAttributes, _ state: State, now: Date) -> String? {
        let zone = timeZone(attributes)
        let time = clock(state.safetyExpiresAt, timeZone: zone, now: now)
        guard state.mode == .timer else {
            return state.safetyExpiresAt.timeIntervalSince(now) <= safetyStopNotice ? "Safety stop \(time)" : nil
        }
        // Apple ends a standard Live Activity after eight hours; a longer fixed hold keeps running.
        let displayEnd = attributes.activityStartedAt.addingTimeInterval(BatteryHoldActivityAttributes.displayLimit)
        guard state.safetyExpiresAt > displayEnd else { return "Stops \(time)" }
        return "Stops \(time) · display ends \(clock(displayEnd, timeZone: zone, now: now))"
    }

    static func kilowatts(_ watts: Double) -> String {
        "\((max(0, watts) / 1000).formatted(.number.precision(.fractionLength(1)))) kW"
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
