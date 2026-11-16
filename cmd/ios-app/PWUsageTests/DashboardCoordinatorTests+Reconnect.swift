import Foundation
@testable import PWUsage
import Testing

extension DashboardCoordinatorTests {
    @Test("Tesla reconnect keeps stored readings and app access while disabling live controls")
    func teslaReconnectPreservesStoredData() async {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        let stored = coordinator.live.response
        api.liveError = PWUsageAPIError.requestRejected(statusCode: 409, message: "TESLA_CONNECTION_REQUIRED")
        clock.advance(minutes: 5)
        await coordinator.refreshDue()
        #expect(coordinator.live.response == stored)
        #expect(!coordinator.requiresSignIn)
        #expect(coordinator.canRequestAccountData)
        #expect(coordinator.batteryHold.failure == .needsReauthentication)
        #expect(coordinator.requiresTeslaReconnect)
        api.liveError = nil
        clock.advance(minutes: 5)
        await coordinator.refreshDue()
        #expect(!coordinator.live.isUnavailable)
        #expect(!coordinator.requiresTeslaReconnect)
        #expect(coordinator.batteryHold.failure == nil)
    }
    @Test("Restoring authorization immediately retries a disconnected Tesla account")
    func reconnectImmediatelyRefreshes() async throws {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        api.liveError = PWUsageAPIError.requestRejected(statusCode: 409, message: "TESLA_CONNECTION_REQUIRED")
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(coordinator.requiresTeslaReconnect)
        let attempts = api.liveSiteIDs.count
        api.liveError = nil
        coordinator.authenticationRestored()
        try await eventually { api.liveSiteIDs.count > attempts && !coordinator.requiresTeslaReconnect }
    }
    @Test("Confirming a reconnect is the app asking: one live request, without forcing a history import")
    func reconnectConfirmationJoinsRestoredPoll() async throws {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        api.summary.liveError = PWUsageAPIError.requestRejected(statusCode: 409, message: "TESLA_CONNECTION_REQUIRED")
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(coordinator.requiresTeslaReconnect)
        api.summary.liveError = nil
        api.holdPower = true
        let liveRequests = api.summary.liveSiteIDs.count
        let powerRequests = api.powerSiteIDs.count

        // Both the restored poll and the reconnect's confirmation park on the same power request.
        coordinator.authenticationRestored()
        let confirm = Task { await coordinator.refreshAll(trigger: .automaticRecovery) }
        try await eventually { api.powerSiteIDs.count > powerRequests }
        for _ in 0 ..< 5 { await Task.yield() }
        api.resumePower()
        await confirm.value

        #expect(!coordinator.requiresTeslaReconnect)
        try await staysTrue { api.summary.liveSiteIDs.count == liveRequests + 1 }
        #expect(api.summary.liveRefreshes.dropFirst(liveRequests).allSatisfy { !$0 })
    }

    @Test("Successful readings do not hide a missing Tesla command permission")
    func commandPermissionRequiresReconnect() async {
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        coordinator.handleBatteryHoldError(PWUsageAPIError.requestRejected(statusCode: 409, message: "needs_reauth"))
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(coordinator.requiresTeslaReconnect)
    }
    @Test("Site verification does not clear missing Tesla command permission")
    func siteVerificationPreservesCommandReauthorization() async {
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        coordinator.handleBatteryHoldError(PWUsageAPIError.requestRejected(statusCode: 409, message: "needs_reauth"))
        coordinator.authenticationRestored()
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(coordinator.requiresTeslaReconnect)
        #expect(coordinator.requiresTeslaCommandReauthorization)
    }
}
