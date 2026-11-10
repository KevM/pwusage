import Foundation
@testable import PWUsage
import Testing

/// Home hides readings older than 15 minutes on arrival and waits for fresh ones.
extension DashboardCoordinatorTests {
    private func makeCache() -> (DashboardCache, URL) {
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("dashboard.json")
        let cache = DashboardCache(fileURL: fileURL)
        cache.storeSites([MobileSite(id: "site-1", name: "Home", utility: "Utility")])
        return (cache, fileURL)
    }

    /// Caches one successful run at the clock's current time, then returns a fresh
    /// coordinator restored from that cache after `minutes` have passed.
    private func restored(after minutes: Int, clock: DashboardTestClock,
                          api: DashboardAPISpy) async -> (DashboardCoordinator, URL) {
        let (cache, fileURL) = makeCache()
        let first = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, cache: cache)
        await first.refreshAll(trigger: .userGesture)
        clock.advance(minutes: minutes)
        let coordinator = DashboardCoordinator(
            siteID: "site-1", api: api, clock: clock, cache: DashboardCache(fileURL: fileURL))
        return (coordinator, fileURL)
    }

    @Test("Readings restored after more than 15 minutes wait for a fresh fetch")
    func restoreHoldsOldReadings() async throws {
        let clock = DashboardTestClock()
        let (coordinator, fileURL) = await restored(after: 16, clock: clock, api: DashboardAPISpy())
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        #expect(coordinator.live.freshReadingWait?.since == clock.now)
        #expect(coordinator.bill.freshReadingWait?.since == clock.now)
        #expect(coordinator.live.response != nil)
        #expect(coordinator.bill.response != nil)
    }

    @Test("Readings restored within 15 minutes show right away")
    func restoreShowsRecentReadings() async throws {
        let clock = DashboardTestClock()
        let (coordinator, fileURL) = await restored(after: 15, clock: clock, api: DashboardAPISpy())
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        #expect(coordinator.live.freshReadingWait == nil)
        #expect(coordinator.bill.freshReadingWait == nil)
        #expect(coordinator.power.freshReadingWait != nil)
    }

    @Test("A successful refresh clears every wait")
    func successClearsWait() async throws {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let (cache, fileURL) = makeCache()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, cache: cache)
        #expect(coordinator.live.freshReadingWait != nil)
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(coordinator.live.freshReadingWait == nil)
        #expect(coordinator.bill.freshReadingWait == nil)
        #expect(coordinator.power.freshReadingWait == nil)
    }

    @Test("A failed request marks its wait as failed")
    func failureMarksWait() async throws {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        api.billError = URLError(.notConnectedToInternet)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock)
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(coordinator.bill.freshReadingWait?.hasFailed == true)
        #expect(coordinator.bill.isUnavailable)
        #expect(coordinator.live.freshReadingWait == nil)
    }

    @Test("Pulling to refresh puts failed cards back to waiting")
    func pullRetriesFailedWaits() async throws {
        let clock = DashboardTestClock()
        let api = DashboardAPISpy()
        api.billError = URLError(.notConnectedToInternet)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock)
        await coordinator.refreshAll(trigger: .userGesture)
        api.billError = nil
        api.holdBill = true
        clock.advance(minutes: 1)
        let refresh = Task { await coordinator.refreshAll(trigger: .userGesture) }
        try await eventually { coordinator.bill.freshReadingWait?.hasFailed == false }
        #expect(coordinator.bill.freshReadingWait?.since == clock.now)
        api.resumeRequests()
        await refresh.value
        #expect(coordinator.bill.freshReadingWait == nil)
    }

    @Test("Saving on backgrounding keeps the summary's fetch time")
    func backgroundSaveKeepsFetchTime() async throws {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let (cache, fileURL) = makeCache()
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, cache: cache)
        await coordinator.refreshAll(trigger: .userGesture)
        let fetchedAt = clock.now
        clock.advance(minutes: 20)
        await coordinator.refreshPower(force: true)
        coordinator.scenePhaseChanged(isActive: false)
        #expect(cache.snapshot.live["site-1"]?.savedAt == fetchedAt)
    }

    @Test("Returning after a gap fetches the summary and bill despite their 30 minute cadence")
    func returnAfterGapFetchesWaitingEndpoints() async throws {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock)
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled }
        coordinator.scenePhaseChanged(isActive: false)
        clock.advance(minutes: 20)
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled && coordinator.bill.freshReadingWait == nil }
        #expect(api.summary.liveSiteIDs.count == 2)
        #expect(api.summary.billSiteIDs.count == 2)
    }

    @Test("Returning within 15 minutes keeps the readings and sends no extra summary or bill")
    func quickReturnKeepsReadings() async throws {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock)
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled }
        coordinator.scenePhaseChanged(isActive: false)
        // Under the summary's 5 minute stale-history interval, so only the freshness
        // rule could cause an extra request here.
        clock.advance(minutes: 4)
        coordinator.scenePhaseChanged(isActive: true)
        #expect(coordinator.live.freshReadingWait == nil)
        #expect(coordinator.bill.freshReadingWait == nil)
        try await eventually { coordinator.refreshSettled }
        #expect(api.summary.liveSiteIDs.count == 1)
        #expect(api.summary.billSiteIDs.count == 1)
    }

    @Test("A failed wait goes back to the normal cadence instead of retrying every poll")
    func failedWaitUsesNormalCadence() async throws {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        api.summary.billError = URLError(.notConnectedToInternet)
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock)
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled }
        #expect(coordinator.bill.freshReadingWait?.hasFailed == true)
        for _ in 0 ..< 3 {
            clock.advance(minutes: 1)
            await coordinator.refreshDue()
        }
        #expect(api.summary.billSiteIDs.count == 1)
    }

    @Test("A brief interruption keeps readings the person was just looking at, however old their fetch")
    func briefInterruptionKeepsReadings() async throws {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock)
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled }
        // Power polls each minute; the summary and bill stay on their 30 minute cadence.
        for _ in 0 ..< 20 {
            clock.advance(minutes: 1)
            await coordinator.refreshDue()
        }
        coordinator.scenePhaseChanged(isActive: false)
        coordinator.scenePhaseChanged(isActive: true)
        #expect(coordinator.live.freshReadingWait == nil)
        #expect(coordinator.bill.freshReadingWait == nil)
    }

    @Test("Returning after more than 15 minutes holds the readings in memory")
    func foregroundAfterGapHoldsReadings() async throws {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock)
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled }
        coordinator.scenePhaseChanged(isActive: false)
        clock.advance(minutes: 20)
        api.summary.holdLive = true
        api.summary.holdBill = true
        coordinator.scenePhaseChanged(isActive: true)
        #expect(coordinator.live.freshReadingWait?.since == clock.now)
        #expect(coordinator.bill.freshReadingWait?.since == clock.now)
        api.summary.holdLive = false
        api.summary.holdBill = false
        api.summary.resumeRequests()
    }
}
