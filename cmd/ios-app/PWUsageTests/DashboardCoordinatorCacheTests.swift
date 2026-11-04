import Foundation
@testable import PWUsage
import Testing

extension DashboardCoordinatorTests {
    @Test("Disk snapshots preserve timestamps and restore only the selected site")
    func diskSnapshotsRestorePerSite() async throws {
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("dashboard.json")
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let cache = DashboardCache(fileURL: fileURL)
        cache.storeSites([MobileSite(id: "site-1", name: "Home", utility: "Utility"),
                          MobileSite(id: "site-2", name: "Other", utility: "Utility")])
        let api = DashboardAPISpy()
        let savedAt = Date(timeIntervalSince1970: 1_800_000_000)
        let first = DashboardCoordinator(siteID: "site-1", api: api, now: { savedAt }, timerInterval: nil, cache: cache)
        await first.refreshAll(trigger: .userGesture)
        let reloadedCache = DashboardCache(fileURL: fileURL)
        let restored = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil, cache: reloadedCache)
        #expect(restored.live.response == first.live.response)
        #expect(restored.bill.response == first.bill.response)
        #expect(restored.live.lastSuccess == savedAt)
        #expect(restored.bill.lastSuccess == savedAt)
        #expect(restored.live.cadence.lastAttempt == nil)
        #expect(restored.live.isRestored)
        #expect(restored.bill.isRestored)

        restored.selectSite("site-2")
        #expect(restored.live.response == nil)
        #expect(restored.bill.response == nil)
        restored.selectSite("site-1")
        #expect(restored.live.response == first.live.response)
        api.liveError = URLError(.notConnectedToInternet)
        api.billError = URLError(.notConnectedToInternet)
        await restored.refreshAll(trigger: .userGesture)
        #expect(restored.live.response == first.live.response)
        #expect(restored.bill.response == first.bill.response)
        #expect(restored.live.isUnavailable)
        #expect(restored.live.isRestored)
        api.liveError = nil
        api.billError = nil
        await restored.refreshAll(trigger: .userGesture)
        #expect(!restored.live.isRestored)
        #expect(!restored.bill.isRestored)

        reloadedCache.storeSites([])
        #expect(DashboardCache(fileURL: fileURL).snapshot.live.isEmpty)
        #expect(DashboardCache(fileURL: fileURL).snapshot.bill.isEmpty)
    }

    @Test("Discarding a session ignores an in-flight response and cannot refill cache")
    func discardedSessionCannotRefillCache() async {
        let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("dashboard.json")
        defer { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        let cache = DashboardCache(fileURL: fileURL)
        cache.storeSites([MobileSite(id: "site-1", name: "Home", utility: "Utility")])
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, timerInterval: nil, cache: cache)
        let refresh = Task { await coordinator.refreshAll(trigger: .userGesture) }
        await api.waitUntilLiveRequestStarts()
        coordinator.authenticationInvalidated()
        coordinator.scenePhaseChanged(isActive: false)
        cache.clear()
        api.resumeRequests()
        await refresh.value
        #expect(coordinator.live.response == nil)
        #expect(cache.snapshot.live.isEmpty)
        #expect(DashboardCache(fileURL: fileURL).snapshot.sites.isEmpty)
        #expect(api.billSiteIDs.isEmpty)
    }
}
