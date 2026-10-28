import Foundation
@testable import PWUsage
import Testing

@Suite("Battery hold Live Activity presentation")
struct BatteryHoldActivityPresentationTests {
    typealias P = BatteryHoldActivityPresentation
    private let start = Date(timeIntervalSinceReferenceDate: 813751200) // 2026-10-15T10:00Z
    private let utc = TimeZone(identifier: "UTC")!

    private func state(mode: BatteryHoldMode = .auto, phase: P.State.Phase? = nil, hours: Double = 8,
                       status: P.State.Status = .active) -> P.State {
        P.State(holdId: 7, status: status, mode: mode, phase: phase, originalReserve: 20, targetReserve: 100,
                estimatedLoadW: phase == .loadRunning ? 7200 : nil, startedAt: start,
                safetyExpiresAt: start.addingTimeInterval(hours * 3600),
                checkedAt: phase == nil ? nil : start.addingTimeInterval(900),
                nextCheckAt: phase == nil ? nil : start.addingTimeInterval(1800))
    }

    private func attributes(startedAt: Date) -> BatteryHoldActivityAttributes {
        .init(siteID: "site-1", siteName: "Home", holdID: 7, registrationID: UUID(),
              timeZoneIdentifier: "UTC", activityStartedAt: startedAt)
    }

    @Test("The Live Activity is branded with the pwusage glyph; Control Center keeps its own symbol")
    func glyph() {
        #expect(P.glyphName == "pwusage-glyph")
        #expect(BatteryHoldControlIdentity.symbolName == "bolt.batteryblock")
    }

    private func status(_ state: P.State, stale: Bool = false, now: Date? = nil, startedAt: Date? = nil) -> P.Status? {
        P.status(attributes(startedAt: startedAt ?? start), state, isStale: stale, now: now ?? start)
    }

    @Test("The figures line: charge as a whole number, the current home load, and a peak only when it adds something")
    func figures() {
        var watching = state(phase: .watching)
        #expect(P.batteryText(watching) == nil && P.homeLoadText(watching) == nil && P.peakText(watching) == nil)
        watching.batteryPercent = 81.6
        watching.homeLoadW = 1840
        watching.peakLoadW = 1790
        #expect(P.batteryText(watching) == "82%")
        #expect(P.homeLoadText(watching) == "1.8 kW")
        #expect(P.kilowatts(7000) == "7.0 kW")
        // A peak that reads the same as the current load is noise.
        #expect(P.peakText(watching) == nil)
        watching.peakLoadW = 7240
        #expect(P.peakText(watching) == "peak 7.2 kW")
        watching.batteryPercent = .nan
        #expect(P.batteryText(watching) == nil)
        // A finished hold keeps its last charge but no load.
        var restored = watching
        restored.status = .restored
        restored.batteryPercent = 71
        #expect(P.batteryText(restored) == "71%")
        #expect(P.homeLoadText(restored) == nil && P.peakText(restored) == nil)
    }

    @Test("A normal active hold needs no status line: the figures say it")
    func quietWhenNormal() {
        for phase: P.State.Phase in [.watching, .loadRunning, .unknown] {
            #expect(status(state(phase: phase)) == nil)
        }
    }

    @Test("Problems get a short warning, and an overdue update wins over everything")
    func warnings() {
        #expect(status(state(phase: .waitingForData)) == .init(text: "Usage data delayed", isWarning: true))
        #expect(status(state(phase: .checkFailed)) == .init(text: "Last check failed", isWarning: true))
        #expect(status(state(phase: .confirmingEnd), stale: true) == .init(text: "Update overdue", isWarning: true))
        #expect(status(state(mode: .timer, phase: .timer), stale: true)?.text == "Update overdue")
    }

    @Test("Transitions are said in a few words")
    func transitions() {
        #expect(status(state(phase: .confirmingEnd)) == .init(text: "Home use dropped, confirming", isWarning: false))
        #expect(status(state(phase: .restoring))?.text == "Confirming with Tesla")
        #expect(P.headline(state(phase: .loadRunning)) == "Saving your Powerwall at 100%")
        var reason = state(phase: .loadRunning)
        reason.restoreReason = .loadEnded
        #expect(P.isRestoring(reason))
        #expect(P.headline(reason) == "Restoring 20% backup reserve")
        #expect(status(reason)?.text == "Confirming with Tesla")
        #expect(status(state())?.text == "Waiting for first check")
        for phase: P.State.Phase in [.watching, .loadRunning, .confirmingEnd, .waitingForData, .checkFailed, .timer, .restoring, .unknown] {
            let text = (status(state(phase: phase))?.text ?? "").lowercased()
            #expect(!text.contains("car") && !text.contains("vehicle") && !text.contains("charging"))
        }
    }

    @Test("Fixed holds show their stop time; Auto shows its safety stop only in the last hour")
    func deadlines() {
        let timer = state(mode: .timer, phase: .timer, hours: 4)
        #expect(status(timer) == .init(text: "Stops \(P.clock(timer.safetyExpiresAt, timeZone: utc, now: start))", isWarning: false))
        let auto = state(phase: .watching)
        #expect(status(auto) == nil)
        #expect(status(auto, now: start.addingTimeInterval(6.9 * 3600)) == nil)
        let lastHour = start.addingTimeInterval(7 * 3600 + 60)
        #expect(status(auto, now: lastHour)?.text == "Safety stop \(P.clock(auto.safetyExpiresAt, timeZone: utc, now: lastHour))")
        // A warning outranks the deadline.
        #expect(status(state(mode: .timer, phase: .checkFailed, hours: 4))?.text == "Last check failed")
    }

    @Test("Final states say how the hold ended, briefly, and only what is known")
    func finalStates() {
        var restored = state(status: .restored)
        restored.restoreReason = .manual
        #expect(P.headline(restored) == "Backup reserve restored to 20%")
        #expect(status(restored)?.text == "Stopped in pwusage")
        restored.restoreReason = .loadEnded
        #expect(status(restored)?.text == "Home use dropped")
        restored.restoreReason = .safetyTimeout
        #expect(status(restored)?.text == "8-hour safety limit")
        restored.restoreReason = .timerElapsed
        #expect(status(restored)?.text == "Stop time reached")
        var cancelled = state(status: .cancelled)
        #expect(P.headline(cancelled) == "Battery Saver stopped")
        cancelled.cancelledObservedReserve = 45
        #expect(status(cancelled)?.text == "Backup reserve set to 45% outside pwusage")
        cancelled.cancelledObservedReserve = nil
        #expect(status(cancelled)?.text == "Backup reserve changed outside pwusage")
        let ended = state(status: .ended)
        #expect(P.headline(ended) == "Battery Saver ended")
        #expect(status(ended) == .init(text: "Open pwusage for details", isWarning: false))
    }

    @Test("Copy follows the voice guide: Powerwall named first, backup reserve in full, no bare job")
    func voice() {
        var restored = state(status: .restored)
        restored.restoreReason = .loadEnded
        var restoring = state(phase: .restoring)
        restoring.restoreReason = .loadEnded
        let texts = [P.headline(state(phase: .watching)), P.headline(restoring), P.headline(restored), status(restored)?.text ?? ""]
        #expect(texts[0].contains("Powerwall"))
        for text in texts {
            #expect(!text.lowercased().contains("job"))
            if text.lowercased().contains("reserve") { #expect(text.lowercased().contains("backup reserve")) }
        }
    }

    @Test("A state goes stale ten minutes after its next check is due")
    func staleAfterNextCheck() {
        let watching = state(phase: .watching)
        #expect(watching.staleDate(activityStartedAt: start) == start.addingTimeInterval(1800 + 600))
        // The activity's start doesn't matter once a check is scheduled.
        #expect(watching.staleDate(activityStartedAt: start.addingTimeInterval(3600)) == start.addingTimeInterval(1800 + 600))
    }

    @Test("Before the first check, a state goes stale one check interval plus ten minutes after the activity started")
    func staleBeforeFirstCheck() {
        let first = state()
        #expect(first.nextCheckAt == nil)
        let activityStart = start.addingTimeInterval(120)
        #expect(first.staleDate(activityStartedAt: activityStart) == activityStart.addingTimeInterval(25 * 60))
    }

    @Test("Final states never go stale")
    func finalNeverStale() {
        for status: P.State.Status in [.restored, .cancelled, .ended, .unknown] {
            #expect(state(phase: .watching, status: status).staleDate(activityStartedAt: start) == nil)
            #expect(state(status: status).staleDate(activityStartedAt: start) == nil)
        }
    }

    @Test("Times on another day name the weekday")
    func clock() {
        let sameDay = P.clock(start.addingTimeInterval(3600), timeZone: utc, now: start)
        let nextDay = P.clock(start.addingTimeInterval(20 * 3600), timeZone: utc, now: start)
        #expect(!sameDay.contains("Fri"))
        #expect(nextDay.contains("Fri"))
    }

    @Test("Holds longer than Apple's eight-hour display limit say the display ends first")
    func displayLimit() {
        let long = state(mode: .timer, phase: .timer, hours: 24)
        let text = status(long)?.text ?? ""
        #expect(text.hasPrefix("Stops ") && text.hasSuffix(" · display ends \(P.clock(start.addingTimeInterval(8 * 3600), timeZone: utc, now: start))"))
        #expect(status(state(mode: .timer, phase: .timer, hours: 8))?.text.contains("display") == false)
        // Started late in an Auto hold, the activity still ends after its safety deadline.
        #expect(status(state(phase: .watching), now: start.addingTimeInterval(7.5 * 3600), startedAt: start.addingTimeInterval(3600))?.text.contains("display") == false)
    }

    @Test("The sheet explains the eight-hour display limit only for holds that outlast it")
    func sheetLimitText() {
        let hold = { (hours: Double) in
            BatteryHold(id: 7, siteID: "site-1", status: .active, mode: .timer, originalReserve: 20, targetReserve: 100,
                        createdAt: start, safetyExpiresAt: start.addingTimeInterval(hours * 3600), cancelledObservedReserve: nil)
        }
        #expect(BatteryHoldPresentation.liveActivityLimitText(hold(24), at: start)?.contains("eight hours") == true)
        #expect(BatteryHoldPresentation.liveActivityLimitText(hold(8), at: start) == nil)
        #expect(BatteryHoldPresentation.liveActivityLimitText(hold(24), at: start.addingTimeInterval(17 * 3600)) == nil)
    }
}
