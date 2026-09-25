import Foundation
import Testing
@testable import PWUsage

@MainActor
@Suite("Dashboard Coordinator Tests", .serialized)
struct DashboardCoordinatorTests {
    @Test("Initial foreground load and exact sixty minute request counts")
    func initialForegroundLoadAndExactSixtyMinuteRequestCounts() async throws {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)

        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1"])

        for _ in 1..<60 {
            clock.advance(minutes: 1)
            await coordinator.refreshDue()
        }

        #expect(api.liveSiteIDs.count == 12, "Live is fetched at t=0,5,...,55 in [0,60m).")
        #expect(api.billSiteIDs.count == 2, "Bill is fetched at t=0,30 in [0,60m).")
    }

    @Test("Background suspends polling and foreground return makes one due request")
    func backgroundSuspendsPollingAndForegroundReturnMakesOneDueRequest() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: .seconds(3_600))
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(coordinator.pollingTimerIsActive)
        coordinator.scenePhaseChanged(isActive: false)
        #expect(!coordinator.pollingTimerIsActive)

        clock.advance(minutes: 60)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 1)

        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(coordinator.pollingTimerIsActive)
        #expect(api.liveSiteIDs.count == 2, "Returning after missed intervals performs one refresh, not catch-up calls.")
        #expect(api.billSiteIDs.count == 2)
    }

    @Test("Duplicate scene and timer events do not fetch before endpoint is due")
    func duplicateSceneAndTimerEventsDoNotFetchBeforeEndpointIsDue() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        await coordinator.refreshDue()

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 1)
    }

    @Test("In-flight refreshes are deduplicated")
    func inFlightRefreshesAreDeduplicated() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        api.holdBill = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let first = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()
        let second = Task { await coordinator.refreshDue() }
        await Task.yield()
        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 0)

        api.resumeRequests()
        await first.value
        await second.value
        #expect(api.billSiteIDs.count == 1)
    }

    @Test("Bill waits for live request so it can see refreshed energy history")
    func billWaitsForLiveRequestSoItCanSeeRefreshedEnergyHistory() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: Date.init, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let first = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 0)

        api.resumeRequests()
        await first.value
        #expect(api.billSiteIDs.count == 1)
    }

    @Test("Site switch resets cadence and ignores old site response")
    func siteSwitchResetsCadenceAndIgnoresOldSiteResponse() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        api.holdLive = true
        api.holdBill = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        let first = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()

        coordinator.selectSite("site-2")
        await Task.yield()
        api.resumeRequests()
        await first.value
        await coordinator.refreshDue()

        #expect(api.liveSiteIDs == ["site-1", "site-2"])
        #expect(api.billSiteIDs == ["site-2"])
        #expect(coordinator.live.response?.site.id == "site-2")
        #expect(coordinator.bill.response?.site.id == "site-2")
    }

    @Test("Unauthorized stops polling and signals sign-in")
    func unauthorizedStopsPollingAndSignalsSignIn() async {
        let api = DashboardAPISpy()
        api.liveError = PWUsageAPIError.signInRequired
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()

        #expect(coordinator.requiresSignIn)
        #expect(!coordinator.isForeground)
        #expect(coordinator.live.lastAttempt == Date(timeIntervalSince1970: 0))
        #expect(coordinator.live.lastSuccess == nil)
        let liveRequestsAfterUnauthorized = api.liveSiteIDs.count
        let billRequestsAfterUnauthorized = api.billSiteIDs.count

        await coordinator.refreshDue()
        #expect(api.liveSiteIDs.count == liveRequestsAfterUnauthorized)
        #expect(api.billSiteIDs.count == billRequestsAfterUnauthorized)

        api.liveError = nil
        coordinator.authenticationRestored()
        await coordinator.refreshDue()
        #expect(!coordinator.requiresSignIn)
        #expect(api.liveSiteIDs.count == liveRequestsAfterUnauthorized + 1)
    }

    @Test("Server failure keeps stale response and separates attempt from success")
    func serverFailureKeepsStaleResponseAndSeparatesAttemptFromSuccess() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        let priorLive = coordinator.live.response
        let priorSuccess = coordinator.live.lastSuccess
        #expect(priorLive != nil)
        #expect(priorSuccess != nil)

        api.liveError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        clock.advance(minutes: 5)
        await coordinator.refreshDue()

        #expect(coordinator.live.response == priorLive)
        #expect(coordinator.live.lastSuccess == priorSuccess)
        #expect(coordinator.live.lastAttempt == clock.now)
        #expect(coordinator.live.isUnavailable)
        #expect(coordinator.live.unavailableStatusCode == 503)
        #expect(api.liveSiteIDs.count == 2)

        api.liveError = URLError(.notConnectedToInternet)
        clock.advance(minutes: 5)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs.count == 3)
        #expect(coordinator.live.response == priorLive)
        #expect(coordinator.live.lastSuccess == priorSuccess)
        #expect(coordinator.live.isUnavailable)
        #expect(coordinator.live.unavailableStatusCode == nil)

        await coordinator.refreshDue()
        #expect(api.liveSiteIDs.count == 3, "A failed attempt still anchors cadence to prevent rapid retries.")
    }

    @Test("Force refreshAll bypasses interval checks and fetches both live and bill")
    func forceRefreshAllBypassesIntervalChecksAndFetchesBoth() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1"])

        // Advance by only 1 minute (neither live 5m nor bill 30m is due)
        clock.advance(minutes: 1)
        await coordinator.refreshAll(force: true)

        #expect(api.liveSiteIDs == ["site-1", "site-1"])
        #expect(api.billSiteIDs == ["site-1", "site-1"])
    }

    @Test("Force refreshBill bypasses interval checks and fetches only bill")
    func forceRefreshBillBypassesIntervalChecksAndFetchesOnlyBill() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1"])

        // Advance by only 1 minute
        clock.advance(minutes: 1)
        await coordinator.refreshBill(force: true)

        #expect(api.liveSiteIDs == ["site-1"])
        #expect(api.billSiteIDs == ["site-1", "site-1"])
    }

    @Test("refreshBill does not wait for in-flight live task")
    func refreshBillDoesNotWaitForInFlightLiveTask() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: Date.init, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let liveCall = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 0)

        // refreshBill should execute immediately without waiting for live task to finish
        await coordinator.refreshBill(force: true)
        #expect(api.billSiteIDs.count == 1)

        api.resumeRequests()
        await liveCall.value
    }

    @Test("Concurrent refreshAll and refreshBill coalesce in-flight requests")
    func concurrentRefreshesCoalesceInFlightRequests() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        api.holdBill = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let first = Task { await coordinator.refreshAll(force: true) }
        await api.waitUntilLiveRequestStarts()
        let second = Task { await coordinator.refreshAll(force: true) }

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 0)

        api.resumeRequests()
        await first.value
        await second.value

        #expect(api.liveSiteIDs.count == 1)
        #expect(api.billSiteIDs.count == 1)

        api.holdBill = true
        let bill1 = Task { await coordinator.refreshBill(force: true) }
        await api.waitUntilBillRequestStarts(targetCount: 2)
        let bill2 = Task { await coordinator.refreshBill(force: true) }

        api.resumeRequests()
        await bill1.value
        await bill2.value

        #expect(api.billSiteIDs.count == 2)
    }

    @Test("refreshAll and refreshBill early return when requiresSignIn is true")
    func refreshesEarlyReturnWhenRequiresSignIn() async {
        let api = DashboardAPISpy()
        api.liveError = PWUsageAPIError.signInRequired
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(coordinator.requiresSignIn)

        let liveCount = api.liveSiteIDs.count
        let billCount = api.billSiteIDs.count

        await coordinator.refreshAll(force: true)
        await coordinator.refreshBill(force: true)

        #expect(api.liveSiteIDs.count == liveCount)
        #expect(api.billSiteIDs.count == billCount)
    }
}

@MainActor
private final class TestClock {
    private(set) var now = Date(timeIntervalSince1970: 1_800_000_000)

    func advance(minutes: Int) {
        now = now.addingTimeInterval(TimeInterval(minutes * 60))
    }
}

@MainActor
private final class DashboardAPISpy: MobileDashboardDataAPI {
    private(set) var liveSiteIDs: [String] = []
    private(set) var billSiteIDs: [String] = []
    var liveError: Error?
    var billError: Error?
    var holdLive = false
    var holdBill = false
    private var liveContinuations: [(String, CheckedContinuation<MobileLiveResponse, Error>)] = []
    private var billContinuations: [(String, CheckedContinuation<MobileBillResponse, Error>)] = []
    private var liveStartWaiters: [CheckedContinuation<Void, Never>] = []
    private var billStartWaiters: [(Int, CheckedContinuation<Void, Never>)] = []

    func fetchLive(siteID: String) async throws -> MobileLiveResponse {
        liveSiteIDs.append(siteID)
        let waiters = liveStartWaiters
        liveStartWaiters.removeAll()
        waiters.forEach { $0.resume() }
        if holdLive {
            return try await withCheckedThrowingContinuation { liveContinuations.append((siteID, $0)) }
        }
        if let liveError { throw liveError }
        return Self.liveResponse(siteID: siteID)
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        billSiteIDs.append(siteID)
        let currentCount = billSiteIDs.count
        billStartWaiters.removeAll { targetCount, continuation in
            if currentCount >= targetCount {
                continuation.resume()
                return true
            }
            return false
        }
        if holdBill {
            return try await withCheckedThrowingContinuation { billContinuations.append((siteID, $0)) }
        }
        if let billError { throw billError }
        return Self.billResponse(siteID: siteID)
    }

    func waitUntilLiveRequestStarts() async {
        if !liveSiteIDs.isEmpty { return }
        await withCheckedContinuation { liveStartWaiters.append($0) }
    }

    func waitUntilBillRequestStarts(targetCount: Int = 1) async {
        if billSiteIDs.count >= targetCount { return }
        await withCheckedContinuation { billStartWaiters.append((targetCount, $0)) }
    }

    func resumeRequests() {
        holdLive = false
        holdBill = false
        let livePending = liveContinuations
        liveContinuations.removeAll()
        livePending.forEach { siteID, continuation in continuation.resume(returning: Self.liveResponse(siteID: siteID)) }
        let billPending = billContinuations
        billContinuations.removeAll()
        billPending.forEach { siteID, continuation in continuation.resume(returning: Self.billResponse(siteID: siteID)) }
    }

    private static func liveResponse(siteID: String) -> MobileLiveResponse {
        let json = #"{"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC","localDate":"2026-09-23"},"live":{"solarPower":1,"loadPower":2,"batteryPower":3,"gridPower":4},"stateOfCharge":50,"activeTariff":"Peak","today":{"homeKwh":1,"solarKwh":2,"gridNetKwh":3,"batteryNetKwh":4},"todayComplete":true,"currentBill":null,"sources":{"liveStatusAt":"2026-09-23T12:00:00Z","energyDataThrough":null}}"#
        return try! MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data(json.utf8))
    }

    private static func billResponse(siteID: String) -> MobileBillResponse {
        let json = #"{"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC"},"currentBill":{"estimatedCost":42,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z","periods":[]},"sources":{"calculatedAt":"2026-09-23T12:00:00Z","energyDataThrough":null}}"#
        return try! MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(json.utf8))
    }
}
