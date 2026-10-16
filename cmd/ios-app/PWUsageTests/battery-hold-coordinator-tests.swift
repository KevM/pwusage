import Foundation
import Testing
@testable import PWUsage

@MainActor
@Suite("Battery hold coordinator", .serialized, .timeLimit(.minutes(1)))
struct BatteryHoldCoordinatorTests {
    @Test("Start, restore and dismiss reconcile server state")
    func commands() async throws {
        let api = BatteryHoldAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        await coordinator.refreshBatteryHold()
        #expect(coordinator.batteryHold.isCurrent)
        api.commandResult = .init(status: .ok, hold: try Self.hold(), current: nil)
        api.response = .init(hold: try Self.hold(), notice: nil)
        await coordinator.sendBatteryHoldCommand(.park(.init(mode: .auto)))
        #expect(coordinator.batteryHold.response?.hold?.targetReserve == 80)
        api.commandResult = .init(status: .reserveChanged, hold: nil, current: 45)
        api.response = .init(hold: nil, notice: try Self.hold(cancelled: true))
        await coordinator.sendBatteryHoldCommand(.restore)
        #expect(coordinator.batteryHold.response?.hold == nil)
        #expect(coordinator.batteryHold.response?.notice?.cancelledObservedReserve == 45)
        api.commandResult = .init(status: .ok, hold: nil, current: nil)
        api.response = .init(hold: nil, notice: nil)
        await coordinator.sendBatteryHoldCommand(.dismiss)
        #expect(coordinator.batteryHold.response?.notice == nil)
        #expect(api.commands.count == 3)
    }

    @Test("Failed refresh preserves saved state but prevents commands")
    func failedRefresh() async throws {
        let api = BatteryHoldAPISpy()
        api.response = .init(hold: try Self.hold(), notice: nil)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        await coordinator.refreshBatteryHold()
        api.error = URLError(.notConnectedToInternet)
        await coordinator.refreshBatteryHold()
        #expect(coordinator.batteryHold.response?.hold != nil)
        #expect(coordinator.batteryHold.isCurrent == false)
        await coordinator.sendBatteryHoldCommand(.restore)
        #expect(api.commands.isEmpty)
        api.error = nil
        await coordinator.refreshBatteryHold()
        #expect(coordinator.batteryHold.isCurrent)
    }

    @Test("Permission and charge-change errors are actionable")
    func commandErrors() async {
        let api = BatteryHoldAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        await coordinator.refreshBatteryHold()
        api.error = PWUsageAPIError.requestRejected(statusCode: 409, message: "needs_reauth")
        await coordinator.sendBatteryHoldCommand(.park(.init(mode: .auto)))
        #expect(coordinator.batteryHold.failure == .needsReauthentication)
        api.error = PWUsageAPIError.requestRejected(statusCode: 422, message: "needs_choice")
        await coordinator.sendBatteryHoldCommand(.park(.init(mode: .auto)))
        #expect(coordinator.batteryHold.requiresReserveChoice)
        #expect(coordinator.batteryHold.failure == .needsChoice)
    }

    @Test("A pending Tesla reserve sync reports a safe retry without losing confirmed state")
    func reserveSyncPending() async throws {
        let api = BatteryHoldAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        await coordinator.refreshBatteryHold()
        api.error = PWUsageAPIError.requestRejected(statusCode: 409, message: "reserve_sync_pending")
        await coordinator.sendBatteryHoldCommand(.park(.init(mode: .auto)))
        #expect(coordinator.batteryHold.failure == .reserveSyncPending)
        #expect(coordinator.batteryHold.isCurrent)
        #expect(coordinator.batteryHold.failure?.message.contains("previous hold") == true)
        api.error = nil
        api.commandResult = .init(status: .ok, hold: try Self.hold(), current: nil)
        api.response = .init(hold: try Self.hold(), notice: nil)
        await coordinator.sendBatteryHoldCommand(.park(.init(mode: .auto)))
        #expect(coordinator.batteryHold.failure == nil)
        #expect(coordinator.batteryHold.response?.hold != nil)
    }

    @Test("Site changes discard pending state and duplicate commands are blocked")
    func siteChangeDuringCommand() async {
        let api = BatteryHoldAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        await coordinator.refreshBatteryHold()
        api.pauseCommand = true
        let pending = Task { await coordinator.sendBatteryHoldCommand(.restore) }
        await api.waitForCommand()
        await coordinator.sendBatteryHoldCommand(.restore)
        #expect(api.commands.count == 1)
        coordinator.selectSite("site-2")
        api.resume()
        await pending.value
        #expect(coordinator.batteryHold.response == nil)
        #expect(coordinator.batteryHold.isSubmitting == false)
    }

    @Test("Session expiry clears hold state and disallows new requests")
    func signInRequired() async {
        let api = BatteryHoldAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        await coordinator.refreshBatteryHold()
        api.error = PWUsageAPIError.signInRequired
        await coordinator.refreshBatteryHold()
        #expect(coordinator.requiresSignIn)
        #expect(coordinator.batteryHold.response == nil)
        let reads = api.readCount
        await coordinator.refreshBatteryHold()
        #expect(api.readCount == reads)
    }

    @Test("A read finishing after sign-out cannot repopulate hold state")
    func signOutDuringRead() async {
        let api = BatteryHoldAPISpy()
        api.pauseRead = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        let pending = Task { await coordinator.refreshBatteryHold() }
        await api.waitForCommand()
        coordinator.authenticationInvalidated()
        api.resume()
        await pending.value
        #expect(coordinator.batteryHold.response == nil)
        #expect(coordinator.batteryHold.isRefreshing == false)
    }

    @Test("Restoration stays available without a battery charge reading or tariff")
    func restoreWithoutCharge() async throws {
        let api = BatteryHoldAPISpy()
        api.response = .init(hold: try Self.hold(), notice: nil)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        await coordinator.refreshBatteryHold()
        #expect(coordinator.batteryHoldStateOfCharge(at: .now) == nil)
        #expect(BatteryHoldPresentation.canControl(state: coordinator.batteryHold, at: .now))
        api.response = .init(hold: nil, notice: nil)
        await coordinator.sendBatteryHoldCommand(.restore)
        #expect(api.commands == [.restore])
    }

    @Test("Expired hold status cannot authorize a new command")
    func expiredStatus() async {
        let api = BatteryHoldAPISpy()
        var now = Date.now
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { now }, timerInterval: nil)
        await coordinator.refreshBatteryHold()
        now = now.addingTimeInterval(121)
        await coordinator.sendBatteryHoldCommand(.park(.init(mode: .auto)))
        #expect(api.commands.isEmpty)
        #expect(BatteryHoldPresentation.toolbarAccessibilityLabel(state: coordinator.batteryHold, at: now).contains("unknown"))
    }

    @Test("Battery Saver navigation labels describe unknown, idle and active status")
    func batterySaverNavigationLabels() async throws {
        let now = Date.now
        let unknown = BatteryHoldState()
        #expect(BatteryHoldPresentation.toolbarLabel(state: unknown, at: now) == "Battery Saver")
        #expect(BatteryHoldPresentation.toolbarAccessibilityLabel(state: unknown, at: now) == "Battery Saver, status unknown")

        let api = BatteryHoldAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { now }, timerInterval: nil)
        await coordinator.refreshBatteryHold()
        #expect(BatteryHoldPresentation.toolbarLabel(state: coordinator.batteryHold, at: now) == "Battery Saver")
        #expect(BatteryHoldPresentation.toolbarAccessibilityLabel(state: coordinator.batteryHold, at: now) == "Battery Saver. Open Battery Saver.")

        api.response = .init(hold: try Self.hold(), notice: nil)
        await coordinator.refreshBatteryHold()
        #expect(BatteryHoldPresentation.toolbarLabel(state: coordinator.batteryHold, at: now) == "Battery Saver On")
        #expect(BatteryHoldPresentation.toolbarAccessibilityLabel(state: coordinator.batteryHold, at: now) == "Battery Saver on, saving your Powerwall at 80%. Open Battery Saver.")
    }

    @Test("Cancelling a pending refresh does not publish its response")
    func cancelledRead() async {
        let api = BatteryHoldAPISpy()
        api.pauseRead = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        let pending = Task { await coordinator.refreshBatteryHold() }
        await api.waitForCommand()
        pending.cancel()
        api.resume()
        await pending.value
        #expect(coordinator.batteryHold.response == nil)
        #expect(coordinator.batteryHold.isRefreshing == false)
        #expect(coordinator.batteryHold.failure == nil)
    }

    @Test("Periodic refreshes coalesce across the screen and sheet")
    func refreshCadence() async {
        let api = BatteryHoldAPISpy()
        var now = Date.now
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { now }, timerInterval: nil)
        await coordinator.refreshBatteryHold()
        now = now.addingTimeInterval(30)
        await coordinator.refreshBatteryHold(force: false)
        #expect(api.readCount == 1)
        now = now.addingTimeInterval(30)
        await coordinator.refreshBatteryHold(force: false)
        #expect(api.readCount == 2)
    }

    @Test("Confirmed starts, stops and reads reach the Live Activity observer; failures don't")
    func liveActivityObserver() async throws {
        let api = BatteryHoldAPISpy()
        let observer = ConfirmationRecorder()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        coordinator.batteryHoldActivityObserver = observer
        await coordinator.refreshBatteryHold()
        #expect(observer.events == ["refreshed:nil"])

        api.commandResult = .init(status: .ok, hold: try Self.hold(), current: nil)
        api.response = .init(hold: try Self.hold(), notice: nil)
        await coordinator.sendBatteryHoldCommand(.park(.init(mode: .auto)))
        let holdID = try Self.hold().id
        #expect(observer.events.suffix(2) == ["started:\(holdID)", "refreshed:\(holdID)"])

        api.commandResult = .init(status: .ok, hold: nil, current: nil)
        api.response = .init(hold: nil, notice: nil)
        await coordinator.sendBatteryHoldCommand(.restore)
        #expect(observer.events.suffix(2) == ["stopped:\(holdID)", "refreshed:nil"])
        #expect(observer.siteIDs == Set(["site-1"]))

        let before = observer.events.count
        api.error = URLError(.timedOut)
        await coordinator.refreshBatteryHold()
        #expect(observer.events.count == before)
    }

    private static func hold(cancelled: Bool = false) throws -> BatteryHold {
        let json = cancelled ? BatteryHoldTests.holdJSON
            .replacingOccurrences(of: "\"active\"", with: "\"cancelled\"")
            .replacingOccurrences(of: "\"cancelled_observed_reserve\":null", with: "\"cancelled_observed_reserve\":45") : BatteryHoldTests.holdJSON
        return try MobileContractDecoder.make().decode(BatteryHold.self, from: Data(json.utf8))
    }
}

@MainActor
private final class BatteryHoldAPISpy: MobileDashboardDataAPI, MobileBatteryHoldDataAPI {
    var response = BatteryHoldResponse(hold: nil, notice: nil)
    var commandResult = BatteryHoldCommandResult(status: .ok, hold: nil, current: nil)
    var error: (any Error)?
    var commands: [BatteryHoldCommand] = []
    var readCount = 0
    var pauseCommand = false
    var pauseRead = false
    private var continuation: CheckedContinuation<Void, Never>?
    private var started: CheckedContinuation<Void, Never>?

    func fetchLive(siteID: String) async throws -> MobileLiveResponse { throw URLError(.unsupportedURL) }
    func fetchBill(siteID: String) async throws -> MobileBillResponse { throw URLError(.unsupportedURL) }
    func fetchBatteryHold(siteID: String) async throws -> BatteryHoldResponse {
        readCount += 1
        if pauseRead { await pause() }
        if let error { throw error }
        return response
    }
    func sendBatteryHoldCommand(siteID: String, command: BatteryHoldCommand) async throws -> BatteryHoldCommandResult {
        commands.append(command)
        if pauseCommand { await pause() }
        if let error { throw error }
        return commandResult
    }
    private func pause() async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            started?.resume()
            started = nil
        }
    }
    func waitForCommand() async {
        guard continuation == nil else { return }
        await withCheckedContinuation { started = $0 }
    }
    func resume() { continuation?.resume(); continuation = nil }
}

@MainActor
private final class ConfirmationRecorder: BatteryHoldActivityObserving {
    var events: [String] = []
    var siteIDs: Set<String> = []
    func batteryHoldConfirmed(_ confirmation: BatteryHoldConfirmation, siteID: String, timeZone: String?) {
        siteIDs.insert(siteID)
        switch confirmation {
        case .refreshed(let response): events.append("refreshed:\(response.hold.map { String($0.id) } ?? "nil")")
        case .started(let hold): events.append("started:\(hold.id)")
        case .stopped(let holdID): events.append("stopped:\(holdID)")
        }
    }
}
