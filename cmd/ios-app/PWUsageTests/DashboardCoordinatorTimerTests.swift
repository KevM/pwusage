import Foundation
@testable import PWUsage
import Testing

extension DashboardCoordinatorTests {
    @Test("Cancelling a refresh caller stops before the bill leg without throwing")
    func cancellingRefreshCallerStopsBeforeTheBill() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil
        )

        let caller = Task { await coordinator.refreshAll(trigger: .userGesture) }
        await api.waitUntilLiveRequestStarts()
        caller.cancel()
        api.resumeRequests()
        await caller.value

        #expect(coordinator.live.response != nil)
        #expect(api.billSiteIDs.isEmpty, "A cancelled refresh must not launch the next leg.")
    }

    @Test("A timer loop that leaves the foreground clears its own handle")
    func timerExitClearsPollingHandle() async throws {
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: DashboardAPISpy(),
            now: { Date(timeIntervalSince1970: 0) }, timerInterval: .milliseconds(20)
        )
        coordinator.isForeground = true
        coordinator.startTimer()
        #expect(coordinator.pollingTimerIsActive)

        coordinator.isForeground = false
        try await eventually { !coordinator.pollingTimerIsActive }

        // The exit must leave startTimer usable; a stale handle made it a no-op.
        coordinator.isForeground = true
        coordinator.startTimer()
        #expect(coordinator.pollingTimerIsActive)
        coordinator.stopTimer()
    }

    @Test("A cancelled polling loop clears its handle")
    func cancelledTimerClearsItsHandle() async throws {
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: DashboardAPISpy(),
            now: { Date(timeIntervalSince1970: 0) }, timerInterval: .milliseconds(20)
        )
        coordinator.isForeground = true
        coordinator.startTimer()
        coordinator.timerTask?.cancel()

        try await eventually { !coordinator.pollingTimerIsActive }
    }
}
