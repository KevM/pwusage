import Foundation
@testable import PWUsage
import Testing

extension DashboardCoordinatorTests {
    @Test("An import still pending gets bounded read-only follow-ups")
    func pendingHistoryGetsBoundedFollowUps() async throws {
        let api = HistoryDashboardAPISpy(status: .pending)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        coordinator.pendingHistoryCheckDelays = [.milliseconds(1), .milliseconds(1)]
        coordinator.scenePhaseChanged(isActive: true)

        try await eventually { coordinator.refreshSettled }

        #expect(api.powerRequests == 1)
        #expect(coordinator.power.response?.sources.liveStatusAt != nil)
        #expect(api.base.liveRefreshes == [false, false, false])
        #expect(api.historyChecks == [false, true, true])
        #expect(coordinator.live.response?.historyRefresh?.status == .pending)
        #expect(api.base.billSiteIDs.count == 1)
    }

    @Test("Follow-ups stop once the import is no longer pending")
    func pendingHistoryStopsWhenSettled() async throws {
        let api = HistoryDashboardAPISpy(status: .pending)
        api.followUpStatuses = [.pending, .current]
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        coordinator.pendingHistoryCheckDelays = [.milliseconds(1), .milliseconds(1), .milliseconds(1)]
        coordinator.scenePhaseChanged(isActive: true)

        try await eventually { coordinator.refreshSettled }

        #expect(api.historyChecks == [false, true, true])
        #expect(coordinator.live.response?.historyRefresh?.status == .current)
    }

    @Test("A summary left pending is rechecked on the short cadence")
    func pendingHistoryUsesShortCadence() async throws {
        let clock = DashboardTestClock()
        let api = HistoryDashboardAPISpy(status: .pending)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
        coordinator.pendingHistoryCheckDelays = []
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled }
        #expect(api.historyChecks == [false])

        clock.advance(minutes: 6)
        api.status = .current
        await coordinator.refreshDue()
        #expect(api.historyChecks == [false, false])

        clock.advance(minutes: 6)
        await coordinator.refreshDue()
        #expect(api.historyChecks == [false, false])
    }

    @Test("The pending check preserves the summary on transient failure and respects sign-in")
    func pendingCheckFailurePreservesSummaryAndAuthorization() async throws {
        let api = HistoryDashboardAPISpy(status: .pending)
        api.followUpError = .recoverableServerError(statusCode: 503)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        coordinator.pendingHistoryCheckDelays = [.milliseconds(1), .milliseconds(1)]
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled }

        #expect(!coordinator.live.isUnavailable)
        #expect(coordinator.live.response?.historyRefresh?.status == .pending)

        api.followUpError = .signInRequired
        await coordinator.refreshAll(trigger: .userGesture)

        #expect(coordinator.requiresSignIn)
        #expect(coordinator.live.response == nil)
    }

    @Test("A foreground recovery fetches one bill when the summary imported new history")
    func foregroundRecoveryRecalculatesTheBill() async throws {
        let clock = DashboardTestClock()
        let api = HistoryDashboardAPISpy(status: .awaitingData)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock)
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled }
        #expect(api.base.billSiteIDs.count == 1)

        coordinator.scenePhaseChanged(isActive: false)
        clock.advance(minutes: 6)
        api.status = .changed
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled }

        #expect(api.base.liveRefreshes == [false, false])
        #expect(api.base.billSiteIDs.count == 2)
    }

    @Test("A pull shares an overlapping summary when it just imported history")
    func pullSharesAnOverlappingSuccessfulImport() async throws {
        let api = HistoryDashboardAPISpy(status: .changed)
        api.base.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await api.base.waitUntilLiveRequestStarts()

        let pull = Task { await coordinator.refreshAll(trigger: .userGesture) }
        try await eventually { coordinator.manualRefreshCount == 1 }
        api.base.resumeLiveRequests()
        await pull.value

        #expect(api.base.liveRefreshes == [false])
        #expect(api.base.billSiteIDs.count == 1)
    }

    @Test("Changed history invalidates a bill that began before the import")
    func changedHistoryRecalculatesAnInFlightBill() async throws {
        let api = HistoryDashboardAPISpy(status: .changed)
        api.base.holdBill = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        let existingBill = Task { await coordinator.refreshBill(trigger: .screenAppearance) }
        await api.base.waitUntilBillRequestStarts()

        let pull = Task { await coordinator.refreshAll(trigger: .userGesture) }
        try await eventually { coordinator.live.response != nil }
        api.base.resumeBillRequests()
        await existingBill.value
        await pull.value

        #expect(api.base.billSiteIDs.count == 2)
    }

    @Test("A Bill pull skips recalculation if its early bill used unchanged history")
    func unchangedHistoryKeepsEarlyBill() async throws {
        let api = HistoryDashboardAPISpy(status: .current)
        api.base.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil)
        let pull = Task { await coordinator.billOutlookRefreshed() }
        await api.base.waitUntilLiveRequestStarts()
        try await eventually { coordinator.bill.response != nil }

        api.base.resumeRequests()
        await pull.value

        #expect(api.base.billSiteIDs.count == 1)
        #expect(api.base.liveRefreshes == [true])
    }
}

@MainActor
private final class HistoryDashboardAPISpy: MobileDashboardDataAPI,
    MobileConditionalDashboardDataAPI, MobileLivePowerDataAPI {
    let base = DashboardAPISpy()
    var status: MobileLiveResponse.HistoryRefreshStatus
    var followUpError: PWUsageAPIError?
    var followUpStatuses: [MobileLiveResponse.HistoryRefreshStatus] = []
    private(set) var historyChecks: [Bool] = []
    private let power = FastDashboardAPISpy(now: Date.init)
    var powerRequests: Int { power.powerSiteIDs.count }

    init(status: MobileLiveResponse.HistoryRefreshStatus) {
        self.status = status
    }

    func fetchLive(siteID: String, refresh: Bool) async throws -> MobileLiveResponse {
        try await fetchLive(siteID: siteID, refresh: refresh, historyCheck: false, reusing: nil)
    }

    func fetchLive(
        siteID: String, refresh: Bool, historyCheck: Bool, reusing cached: MobileLiveResponse?
    ) async throws -> MobileLiveResponse {
        historyChecks.append(historyCheck)
        if historyCheck, let followUpError { throw followUpError }
        var response = try await base.fetchLive(siteID: siteID, refresh: refresh)
        let followUpStatus = historyCheck && !followUpStatuses.isEmpty ? followUpStatuses.removeFirst() : nil
        response.historyRefresh = .init(status: followUpStatus ?? status)
        return response
    }

    func fetchLivePower(siteID: String) async throws -> MobileLivePowerResponse {
        try await power.fetchLivePower(siteID: siteID)
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        try await base.fetchBill(siteID: siteID)
    }

    func fetchBill(siteID: String, reusing cached: MobileBillResponse?) async throws -> MobileBillResponse {
        try await fetchBill(siteID: siteID)
    }
}
