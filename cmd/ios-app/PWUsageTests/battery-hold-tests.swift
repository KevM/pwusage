import Foundation
@testable import PWUsage
import Testing

@Suite("Battery hold")
struct BatteryHoldTests {
    static let holdJSON = #"{"id":1,"site_id":"site-1","status":"active","mode":"auto","original_reserve":20,"target_reserve":80,"created_at":"2026-10-02T12:00:00.000Z","safety_expires_at":"2026-10-02T20:00:00.000Z","cancelled_observed_reserve":null}"#

    @Test("Reserve planning matches every website boundary", arguments: [
        (0.0, 0, false), (79.9, 79, false), (80.0, 80, false),
        (80.1, 80, false), (85.0, 80, false), (85.1, 100, true),
        (94.9, 100, true), (95.0, 100, false), (100.0, 100, false),
    ])
    func reserveBands(_ sample: (Double, Int, Bool)) throws {
        let plan = try #require(BatteryHoldReservePlan.make(stateOfCharge: sample.0))
        #expect(plan.target == sample.1)
        #expect(plan.requiresChoice == sample.2)
    }

    @Test("Invalid charge cannot enable a hold", arguments: [-1.0, 101.0, Double.nan, Double.infinity])
    func invalidCharge(_ charge: Double) {
        #expect(BatteryHoldReservePlan.make(stateOfCharge: charge) == nil)
    }

    @Test("Timer bounds and payload omission are explicit")
    func choices() throws {
        #expect(BatteryHoldChoice(mode: .timer, durationHours: 0).isValid == false)
        #expect(BatteryHoldChoice(mode: .timer, durationHours: 25).isValid == false)
        #expect(BatteryHoldChoice(mode: .timer, durationHours: 24).isValid)
        let data = try JSONEncoder().encode(BatteryHoldCommand.park(.init(mode: .auto)))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(json == ["action": "park", "mode": "auto"])
    }

    @Test("Hold and persisted cancellation decode with site validation")
    func decodesState() throws {
        let notice = Self.holdJSON.replacingOccurrences(of: "\"active\"", with: "\"cancelled\"")
            .replacingOccurrences(of: "\"cancelled_observed_reserve\":null", with: "\"cancelled_observed_reserve\":45")
        let response = try MobileContractDecoder.make().decode(BatteryHoldResponse.self, from: Data("{\"hold\":\(Self.holdJSON),\"notice\":\(notice)}".utf8))
        #expect(try response.validating(siteID: "site-1").hold?.originalReserve == 20)
        #expect(response.notice?.cancelledObservedReserve == 45)
        #expect(throws: PWUsageAPIError.invalidResponse) { try response.validating(siteID: "other") }
    }

    @Test("Malformed active reserves fail closed")
    func rejectsMalformedReserves() throws {
        let body = Self.holdJSON.replacingOccurrences(of: "\"target_reserve\":80", with: "\"target_reserve\":180")
        let response = try MobileContractDecoder.make().decode(BatteryHoldResponse.self, from: Data("{\"hold\":\(body),\"notice\":null}".utf8))
        #expect(throws: PWUsageAPIError.invalidResponse) { try response.validating(siteID: "site-1") }
    }

    @Test("Hold controls require current status, fresh charge and a tariff")
    func availability() {
        let now = Date.now
        var state = BatteryHoldState(response: .init(hold: nil, notice: nil), isCurrent: true, fetchedAt: now)
        #expect(BatteryHoldPresentation.canStart(state: state, stateOfCharge: 75, hasTariff: true, at: now))
        #expect(BatteryHoldPresentation.canStart(state: state, stateOfCharge: nil, hasTariff: true, at: now) == false)
        #expect(BatteryHoldPresentation.canStart(state: state, stateOfCharge: 75, hasTariff: false, at: now) == false)
        #expect(BatteryHoldPresentation.canStart(state: state, stateOfCharge: 75, hasTariff: true, at: now.addingTimeInterval(121)) == false)
        state.isSubmitting = true
        #expect(BatteryHoldPresentation.canStart(state: state, stateOfCharge: 75, hasTariff: true, at: now) == false)
    }

    @Test("Automatic and timer holds explain restoration without assuming it happened")
    func restorationCopy() throws {
        let hold = try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(Self.holdJSON.utf8))
        #expect(BatteryHoldPresentation.restorationText(hold, timeZone: "UTC", at: hold.createdAt) == "Restores your backup reserve automatically when the job finishes.")
        #expect(BatteryHoldPresentation.safetyText(hold, timeZone: "UTC").contains("eight hours"))
        let timer = try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(Self.holdJSON.replacingOccurrences(of: "\"auto\"", with: "\"timer\"").utf8))
        #expect(BatteryHoldPresentation.restorationText(timer, timeZone: "UTC", at: timer.createdAt).contains("Scheduled"))
        #expect(BatteryHoldPresentation.restorationText(timer, timeZone: "UTC", at: timer.safetyExpiresAt).contains("Waiting"))
    }

    @Test("An empty response cannot masquerade as idle status")
    func rejectsMissingState() {
        #expect(throws: (any Error).self) {
            try MobileContractDecoder.make().decode(BatteryHoldResponse.self, from: Data("{}".utf8))
        }
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
        let monitoring = BatteryHoldMonitoring(phase: .loadRunning, checkedAt: now, nextCheckAt: now.addingTimeInterval(480), sampledAt: now, estimatedLoadW: 9000)
        #expect(BatteryHoldPresentation.monitoringText(monitoring, at: now).contains("9 kW"))
        #expect(BatteryHoldPresentation.loadSummary(monitoring, at: now) == "Detected job: about 9 kW")
        #expect(BatteryHoldPresentation.loadSummary(monitoring, at: now.addingTimeInterval(1300)) == nil)
        let waiting = BatteryHoldMonitoring(phase: .waitingForData, checkedAt: now, nextCheckAt: now.addingTimeInterval(480), sampledAt: nil, estimatedLoadW: nil)
        #expect(BatteryHoldPresentation.loadSummary(waiting, at: now) == nil)
        #expect(BatteryHoldPresentation.nextCheckText(monitoring, at: now) == "Checking again in 8 minutes")
        #expect(BatteryHoldPresentation.nextCheckText(monitoring, at: now.addingTimeInterval(481)) == "Waiting for the next check")
        #expect(BatteryHoldPresentation.monitoringText(monitoring, at: now.addingTimeInterval(1300)).contains("updated usage data"))
        #expect(BatteryHoldPresentation.monitoringText(monitoring, at: now.addingTimeInterval(1300)).hasSuffix("Battery Saver is still on."))
        let watching = BatteryHoldMonitoring(phase: .watching, checkedAt: now, nextCheckAt: now.addingTimeInterval(480), sampledAt: now, estimatedLoadW: nil)
        #expect(BatteryHoldPresentation.monitoringText(watching, at: now) == "Waiting for a job to finish.")
    }

    @Test("Monitoring decodes alongside an existing hold and remains optional")
    func monitoringDecoding() throws {
        let monitoring = """
        {"phase":"load_running","checked_at":"2026-10-02T10:16:00Z","next_check_at":"2026-10-02T10:30:00Z","sampled_at":"2026-10-02T10:15:00Z","estimated_load_w":9000}
        """
        let body = Self.holdJSON.dropLast() + ",\"monitoring\":\(monitoring)}"
        let hold = try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(body.utf8))
        #expect(hold.monitoring?.estimatedLoadW == 9000)
        #expect(hold.monitoring?.phase == .loadRunning)
        let oldHold = try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(Self.holdJSON.utf8))
        #expect(oldHold.monitoring == nil)
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
