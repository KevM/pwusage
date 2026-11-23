import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@Suite("Battery hold")
struct BatteryHoldTests {
    static let holdJSON = #"{"id":1,"site_id":"site-1","status":"active","mode":"auto","original_reserve":20,"# +
        #""target_reserve":80,"created_at":"2026-10-02T12:00:00.000Z","# +
        #""safety_expires_at":"2026-10-02T20:00:00.000Z","cancelled_observed_reserve":null}"#

    @Test("Hold controls require current status, fresh charge and a tariff")
    func availability() {
        let now = Date.now
        var state = BatteryHoldState(response: .init(hold: nil, notice: nil), isCurrent: true, fetchedAt: now)
        #expect(BatteryHoldPresentation.canStart(state: state, stateOfCharge: 75, hasTariff: true, at: now))
        #expect(BatteryHoldPresentation.canStart(state: state, stateOfCharge: nil, hasTariff: true, at: now) == false)
        #expect(BatteryHoldPresentation.canStart(state: state, stateOfCharge: 75, hasTariff: false, at: now) == false)
        #expect(BatteryHoldPresentation.canStart(state: state, stateOfCharge: 75, hasTariff: true,
                                                 at: now.addingTimeInterval(121)) == false)
        state.isSubmitting = true
        #expect(BatteryHoldPresentation.canStart(state: state, stateOfCharge: 75, hasTariff: true, at: now) == false)
    }

    @Test("Automatic and timer holds explain restoration without assuming it happened")
    func restorationCopy() throws {
        let hold = try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(Self.holdJSON.utf8))
        #expect(BatteryHoldPresentation.restorationText(hold, timeZone: "UTC", at: hold.createdAt) ==
            "Restores your backup reserve automatically when the job finishes.")
        #expect(BatteryHoldPresentation.safetyText(hold, timeZone: "UTC").contains("eight hours"))
        let timer = try MobileContractDecoder.make().decode(
            BatteryHold.self,
            from: Data(Self.holdJSON.replacingOccurrences(of: "\"auto\"", with: "\"timer\"").utf8)
        )
        #expect(BatteryHoldPresentation.restorationText(timer, timeZone: "UTC", at: timer.createdAt)
            .contains("Scheduled"))
        #expect(BatteryHoldPresentation.restorationText(timer, timeZone: "UTC", at: timer.safetyExpiresAt)
            .contains("Waiting"))
    }

    @Test("Manual restore warns that it replaces settings changed in Tesla")
    func manualRestoreWarning() {
        let message = BatteryHoldPresentation.restoreConfirmationText(originalReserve: 20)
        #expect(message.contains("20%"))
        #expect(message.contains("replaces"))
        #expect(message.contains("Tesla"))
        #expect(message.hasPrefix("Turning off Battery Saver"))
    }
    @Test("Monitoring countdown expires honestly and load text uses kW")
    func monitoringCopy() {
        let now = Date(timeIntervalSince1970: 1000)
        let monitoring = BatteryHoldMonitoring(phase: .loadRunning, checkedAt: now,
                                               nextCheckAt: now.addingTimeInterval(480), sampledAt: now,
                                               estimatedLoadW: 9000)
        #expect(BatteryHoldPresentation.monitoringText(monitoring, at: now).contains("9 kW"))
        #expect(BatteryHoldPresentation.loadSummary(monitoring, at: now) == "Detected job: about 9 kW")
        #expect(BatteryHoldPresentation.loadSummary(monitoring, at: now.addingTimeInterval(1300)) == nil)
        let waiting = BatteryHoldMonitoring(phase: .waitingForData, checkedAt: now,
                                            nextCheckAt: now.addingTimeInterval(480), sampledAt: nil,
                                            estimatedLoadW: nil)
        #expect(BatteryHoldPresentation.loadSummary(waiting, at: now) == nil)
        #expect(BatteryHoldPresentation.nextCheckText(monitoring, at: now) == "Checking again in 8 minutes")
        #expect(BatteryHoldPresentation.nextCheckText(monitoring, at: now.addingTimeInterval(481)) ==
            "Waiting for the next check")
        #expect(BatteryHoldPresentation.monitoringText(monitoring, at: now.addingTimeInterval(1300))
            .contains("updated usage data"))
        #expect(BatteryHoldPresentation.monitoringText(monitoring, at: now.addingTimeInterval(1300))
            .hasSuffix("Battery Saver is still on."))
        let watching = BatteryHoldMonitoring(phase: .watching, checkedAt: now,
                                             nextCheckAt: now.addingTimeInterval(480), sampledAt: now,
                                             estimatedLoadW: nil)
        let expectedWaiting = "Waiting for a job to start. " +
            "Battery Saver turns off if none is detected after two checks."
        #expect(BatteryHoldPresentation.monitoringText(watching, at: now) == expectedWaiting)
    }

    @Test("Toolbar reserve is shown only for a currently confirmed active hold")
    func toolbarReserve() throws {
        let hold = try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(Self.holdJSON.utf8))
        let now = Date.now
        var state = BatteryHoldState(response: .init(hold: hold, notice: nil), isCurrent: true, fetchedAt: now)
        #expect(BatteryHoldPresentation.toolbarReserve(state: state, at: now) == "80%")
        #expect(BatteryHoldPresentation.toolbarReserve(state: state, at: now.addingTimeInterval(121)) == nil)
        state.response = .init(hold: nil, notice: nil)
        #expect(BatteryHoldPresentation.toolbarReserve(state: state, at: now) == nil)
    }
}
