import Foundation
import XCTest
@testable import PWUsage

@MainActor
final class DashboardCoordinatorTests: XCTestCase {
    func testInitialForegroundLoadAndExactSixtyMinuteRequestCounts() async throws {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)

        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        XCTAssertEqual(api.liveSiteIDs, ["site-1"])
        XCTAssertEqual(api.billSiteIDs, ["site-1"])

        for _ in 1..<60 {
            clock.advance(minutes: 1)
            await coordinator.refreshDue()
        }

        XCTAssertEqual(api.liveSiteIDs.count, 12, "Live is fetched at t=0,5,...,55 in [0,60m).")
        XCTAssertEqual(api.billSiteIDs.count, 2, "Bill is fetched at t=0,30 in [0,60m).")
    }

    func testBackgroundSuspendsPollingAndForegroundReturnMakesOneDueRequest() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: .seconds(3_600))
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        XCTAssertTrue(coordinator.pollingTimerIsActive)
        coordinator.scenePhaseChanged(isActive: false)
        XCTAssertFalse(coordinator.pollingTimerIsActive)

        clock.advance(minutes: 60)
        await coordinator.refreshDue()
        XCTAssertEqual(api.liveSiteIDs.count, 1)
        XCTAssertEqual(api.billSiteIDs.count, 1)

        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        XCTAssertTrue(coordinator.pollingTimerIsActive)
        XCTAssertEqual(api.liveSiteIDs.count, 2, "Returning after missed intervals performs one refresh, not catch-up calls.")
        XCTAssertEqual(api.billSiteIDs.count, 2)
    }

    func testDuplicateSceneAndTimerEventsDoNotFetchBeforeEndpointIsDue() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        await coordinator.refreshDue()

        XCTAssertEqual(api.liveSiteIDs.count, 1)
        XCTAssertEqual(api.billSiteIDs.count, 1)
    }

    func testInFlightRefreshesAreDeduplicated() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        api.holdBill = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let first = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()
        let second = Task { await coordinator.refreshDue() }
        await Task.yield()
        XCTAssertEqual(api.liveSiteIDs.count, 1)
        XCTAssertEqual(api.billSiteIDs.count, 0)

        api.resumeRequests()
        await first.value
        await second.value
        XCTAssertEqual(api.billSiteIDs.count, 1)
    }

    func testBillWaitsForLiveRequestSoItCanSeeRefreshedEnergyHistory() async {
        let api = DashboardAPISpy()
        api.holdLive = true
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: Date.init, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)

        let first = Task { await coordinator.refreshDue() }
        await api.waitUntilLiveRequestStarts()

        XCTAssertEqual(api.liveSiteIDs.count, 1)
        XCTAssertEqual(api.billSiteIDs.count, 0)

        api.resumeRequests()
        await first.value
        XCTAssertEqual(api.billSiteIDs.count, 1)
    }

    func testSiteSwitchResetsCadenceAndIgnoresOldSiteResponse() async {
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

        XCTAssertEqual(api.liveSiteIDs, ["site-1", "site-2"])
        XCTAssertEqual(api.billSiteIDs, ["site-2"])
        XCTAssertEqual(coordinator.live.response?.site.id, "site-2")
        XCTAssertEqual(coordinator.bill.response?.site.id, "site-2")
    }

    func testUnauthorizedStopsPollingAndSignalsSignIn() async {
        let api = DashboardAPISpy()
        api.liveError = PWUsageAPIError.signInRequired
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { Date(timeIntervalSince1970: 0) }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()

        XCTAssertTrue(coordinator.requiresSignIn)
        XCTAssertFalse(coordinator.isForeground)
        XCTAssertEqual(coordinator.live.lastAttempt, Date(timeIntervalSince1970: 0))
        XCTAssertNil(coordinator.live.lastSuccess)
        let liveRequestsAfterUnauthorized = api.liveSiteIDs.count
        let billRequestsAfterUnauthorized = api.billSiteIDs.count

        await coordinator.refreshDue()
        XCTAssertEqual(api.liveSiteIDs.count, liveRequestsAfterUnauthorized)
        XCTAssertEqual(api.billSiteIDs.count, billRequestsAfterUnauthorized)

        api.liveError = nil
        coordinator.authenticationRestored()
        await coordinator.refreshDue()
        XCTAssertFalse(coordinator.requiresSignIn)
        XCTAssertEqual(api.liveSiteIDs.count, liveRequestsAfterUnauthorized + 1)
    }

    func testServerFailureKeepsStaleResponseAndSeparatesAttemptFromSuccess() async {
        let clock = TestClock()
        let api = DashboardAPISpy()
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, now: { clock.now }, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        let priorLive = coordinator.live.response
        let priorSuccess = coordinator.live.lastSuccess
        XCTAssertNotNil(priorLive)
        XCTAssertNotNil(priorSuccess)

        api.liveError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        clock.advance(minutes: 5)
        await coordinator.refreshDue()

        XCTAssertEqual(coordinator.live.response, priorLive)
        XCTAssertEqual(coordinator.live.lastSuccess, priorSuccess)
        XCTAssertEqual(coordinator.live.lastAttempt, clock.now)
        XCTAssertTrue(coordinator.live.isUnavailable)
        XCTAssertEqual(coordinator.live.unavailableStatusCode, 503)
        XCTAssertEqual(api.liveSiteIDs.count, 2)

        api.liveError = URLError(.notConnectedToInternet)
        clock.advance(minutes: 5)
        await coordinator.refreshDue()
        XCTAssertEqual(api.liveSiteIDs.count, 3)
        XCTAssertEqual(coordinator.live.response, priorLive)
        XCTAssertEqual(coordinator.live.lastSuccess, priorSuccess)
        XCTAssertTrue(coordinator.live.isUnavailable)
        XCTAssertNil(coordinator.live.unavailableStatusCode)

        await coordinator.refreshDue()
        XCTAssertEqual(api.liveSiteIDs.count, 3, "A failed attempt still anchors cadence to prevent rapid retries.")
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
