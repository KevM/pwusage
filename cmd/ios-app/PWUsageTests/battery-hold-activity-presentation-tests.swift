import Foundation
import Testing
@testable import PWUsage

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

    @Test("The Live Activity uses the Battery Hold control's glyph")
    func glyph() {
        #expect(P.symbolName == BatteryHoldControlIdentity.symbolName)
    }

    @Test("Active holds show the target reserve and the monitor's phase in home-load terms")
    func activePhases() {
        #expect(P.headline(state(phase: .watching)) == "Holding at 100%")
        #expect(P.detail(state(phase: .loadRunning), isStale: false) == "Home load about 7.2 kW above the start.")
        #expect(P.detail(state(phase: .confirmingEnd), isStale: false).contains("Home load dropped"))
        #expect(P.detail(state(), isStale: false) == "Waiting for the first home load check.")
        #expect(P.detail(state(mode: .timer), isStale: false) == "Holding until the scheduled stop time.")
        #expect(P.detail(state(phase: .checkFailed), isStale: false).contains("still active"))
        #expect(P.detail(state(phase: .waitingForData), isStale: false).contains("still active"))
        for phase: P.State.Phase in [.watching, .loadRunning, .confirmingEnd, .waitingForData, .checkFailed, .timer, .restoring, .unknown] {
            let text = P.detail(state(phase: phase), isStale: false).lowercased()
            #expect(!text.contains("car") && !text.contains("vehicle") && !text.contains("charging"))
        }
    }

    @Test("A late update says so instead of presenting old state as current")
    func stale() {
        #expect(P.detail(state(phase: .loadRunning), isStale: true) == "Update overdue. Open pwusage for the current status.")
    }

    @Test("Restoring is presented on purpose, from the phase or a recorded restore reason")
    func restoring() {
        var restoring = state(phase: .restoring)
        #expect(P.headline(restoring) == "Restoring 20% reserve")
        #expect(P.reserveText(restoring) == "20%")
        restoring = state(phase: .loadRunning)
        restoring.restoreReason = .loadEnded
        #expect(P.isRestoring(restoring))
        #expect(P.detail(restoring, isStale: false).contains("Waiting for Tesla to confirm"))
    }

    @Test("Final states say how the hold ended, and only what is known")
    func finalStates() {
        var restored = state(status: .restored)
        restored.restoreReason = .manual
        restored.endedAt = start.addingTimeInterval(3600)
        #expect(P.headline(restored) == "Reserve restored to 20%")
        #expect(P.detail(restored, isStale: false) == "Stopped in pwusage.")
        #expect(P.deadline(restored, timeZone: utc, now: start) == "Ended \(P.clock(restored.endedAt!, timeZone: utc, now: start))")
        var cancelled = state(status: .cancelled)
        cancelled.cancelledObservedReserve = 45
        #expect(P.detail(cancelled, isStale: false).contains("45%"))
        let ended = state(status: .ended)
        #expect(P.headline(ended) == "Battery hold ended")
        #expect(!P.detail(ended, isStale: false).contains("restored"))
        #expect(P.deadline(ended, timeZone: utc, now: start) == nil)
    }

    @Test("Fixed holds show their stop time; Auto shows its safety deadline")
    func deadlines() {
        let timer = state(mode: .timer, phase: .timer, hours: 4)
        #expect(P.deadline(timer, timeZone: utc, now: start) == "Stops \(P.clock(timer.safetyExpiresAt, timeZone: utc, now: start))")
        let auto = state(phase: .watching)
        #expect(P.deadline(auto, timeZone: utc, now: start)?.hasPrefix("Safety stop by ") == true)
        #expect(P.checked(auto, timeZone: utc, now: start) == "Checked \(P.clock(auto.checkedAt!, timeZone: utc, now: start))")
        #expect(P.checked(state(), timeZone: utc, now: start) == nil)
    }

    @Test("The home load range shows the latest sample with its own time, the start and the peak")
    func loadRange() {
        var running = state(phase: .loadRunning)
        running.sampledAt = start.addingTimeInterval(600)
        running.baselineLoadW = 1200
        running.homeLoadW = 8400
        running.peakLoadW = 9100
        let time = P.clock(running.sampledAt!, timeZone: utc, now: start)
        #expect(P.detail(running, isStale: false) == "Home load is running.")
        #expect(P.loadRange(running, timeZone: utc, now: start) == "Home 8.4 kW at \(time) · started 1.2 kW · peak 9.1 kW")
        running.peakLoadW = nil
        running.baselineLoadW = nil
        #expect(P.loadRange(running, timeZone: utc, now: start) == "Home 8.4 kW at \(time)")
        // No sample, a timer hold, or a finished hold: nothing to show.
        #expect(P.loadRange(state(phase: .watching), timeZone: utc, now: start) == nil)
        running.status = .restored
        #expect(P.loadRange(running, timeZone: utc, now: start) == nil)
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
        let note = P.displayLimitNote(attributes(startedAt: start), long, now: start)
        #expect(note?.contains("The hold continues") == true)
        #expect(P.displayLimitNote(attributes(startedAt: start), state(phase: .watching), now: start) == nil)
        // Started late in an Auto hold, the activity still ends after its safety deadline.
        #expect(P.displayLimitNote(attributes(startedAt: start.addingTimeInterval(3600)), state(phase: .watching), now: start) == nil)
        #expect(P.displayLimitNote(attributes(startedAt: start), state(hours: 24, status: .restored), now: start) == nil)
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
