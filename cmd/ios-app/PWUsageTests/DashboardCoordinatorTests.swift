import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Dashboard Coordinator Tests", .serialized)
struct DashboardCoordinatorTests {
    @Test("Fast power polls each minute while history and bill stay on thirty minute cadences")
    func fastPowerDoesNotPollHistory() async throws {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        for _ in 1 ..< 60 {
            clock.advance(minutes: 1)
            await coordinator.refreshDue()
        }
        #expect(api.powerSiteIDs.count == 60)
        #expect(api.summary.liveSiteIDs.count == 2)
        #expect(api.summary.billSiteIDs.count == 2)
        #expect(coordinator.power.response?.sources.liveStatusAt == clock.now)
        #expect(coordinator.live.response?.sources.liveStatusAt != clock.now)
    }

    @Test("Foregrounding refreshes power even inside its poll cadence without repeating summaries")
    func raiseRefreshesPowerOnly() async throws {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        coordinator.scenePhaseChanged(isActive: false)
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { api.powerSiteIDs.count == 2 && coordinator.power.lastSuccess != nil }
        await coordinator.refreshDue()
        #expect(api.summary.liveSiteIDs.count == 1)
        #expect(api.summary.billSiteIDs.count == 1)
    }

    @Test("Raising unsettles Home until its first refresh finishes, so stale cache never flashes a notice")
    func raiseUnsettlesUntilRefreshFinishes() async throws {
        let clock = DashboardTestClock()
        let api = FastDashboardAPISpy(now: { clock.now })
        let coordinator = DashboardCoordinator(siteID: "site-1", api: api, clock: clock, timerInterval: nil)
        #expect(!coordinator.refreshSettled)
        coordinator.scenePhaseChanged(isActive: true)
        try await eventually { coordinator.refreshSettled }

        coordinator.scenePhaseChanged(isActive: false)
        api.holdPower = true
        coordinator.scenePhaseChanged(isActive: true)
        #expect(!coordinator.refreshSettled)
        try await eventually { api.pendingPower != nil }
        #expect(!coordinator.refreshSettled)
        api.holdPower = false
        api.resumePower()
        try await eventually { coordinator.refreshSettled }

        // Later polls keep it settled rather than toggling it.
        clock.advance(minutes: 1)
        await coordinator.refreshDue()
        #expect(coordinator.refreshSettled)
    }
}

@MainActor
final class DashboardTestClock {
    private(set) var now = Date(timeIntervalSince1970: 1_800_000_000)
    /// Wall time and monotonic cadence move together by default, the way they do
    /// on a running device. `advanceWallClock` bends only the wall clock.
    private(set) var monotonicNow = ContinuousClock().now

    func advance(minutes: Int) {
        now = now.addingTimeInterval(TimeInterval(minutes * 60))
        monotonicNow = monotonicNow.advanced(by: .seconds(minutes * 60))
    }

    func advanceWallClock(minutes: Int) {
        now = now.addingTimeInterval(TimeInterval(minutes * 60))
    }
}

extension DashboardCoordinator {
    /// Builds a coordinator whose wall clock and monotonic cadence both follow the
    /// test clock, so `advance(minutes:)` moves the same two timelines a device would.
    convenience init(
        siteID: String,
        api: any MobileDashboardDataAPI,
        planningAPI: (any MobileLoadPlanningDataAPI)? = nil,
        accountScopeID: String? = nil,
        clock: DashboardTestClock,
        timerInterval: Duration? = nil,
        cache: DashboardCache? = nil
    ) {
        self.init(
            siteID: siteID, api: api, planningAPI: planningAPI, accountScopeID: accountScopeID,
            now: { clock.now }, cadenceNow: { clock.monotonicNow },
            timerInterval: timerInterval, cache: cache
        )
    }
}

@MainActor
final class DashboardAPISpy: MobileDashboardDataAPI, MobileLoadPlanningDataAPI {
    private(set) var liveSiteIDs: [String] = []
    private(set) var billSiteIDs: [String] = []
    private(set) var contextSiteIDs: [String] = []
    var liveError: Error?
    var billError: Error?
    var contextError: Error?
    var contextAsOf = Date(timeIntervalSince1970: 1_800_000_000)
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
        return try Self.liveResponse(siteID: siteID)
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
        return try Self.billResponse(siteID: siteID)
    }

    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        contextSiteIDs.append(siteID)
        if let contextError { throw contextError }
        return Self.planningContextResponse(siteID: siteID, asOf: contextAsOf)
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
        resumeLiveRequests()
        resumeBillRequests()
    }

    func resumeLiveRequests() {
        holdLive = false
        let livePending = liveContinuations
        liveContinuations.removeAll()
        for (siteID, continuation) in livePending {
            do {
                continuation.resume(returning: try Self.liveResponse(siteID: siteID))
            } catch {
                // A broken fixture fails the one test awaiting this continuation,
                // with the decode error attached, instead of trapping the binary.
                continuation.resume(throwing: error)
            }
        }
    }

    func resumeBillRequests() {
        holdBill = false
        let billPending = billContinuations
        billContinuations.removeAll()
        for (siteID, continuation) in billPending {
            do {
                continuation.resume(returning: try Self.billResponse(siteID: siteID))
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    func failPendingRequests(_ error: Error) {
        holdLive = false
        holdBill = false
        let livePending = liveContinuations
        liveContinuations.removeAll()
        for (_, continuation) in livePending {
            continuation.resume(throwing: error)
        }
        let billPending = billContinuations
        billContinuations.removeAll()
        for (_, continuation) in billPending {
            continuation.resume(throwing: error)
        }
    }

    private static func liveResponse(siteID: String) throws -> MobileLiveResponse {
        // A charge reading older than two hours decodes as unknown, so date it now rather than
        // reusing the deliberately stale `liveStatusAt` above.
        let chargeAt = ISO8601DateFormatter().string(from: Date())
        let json = #"""
        {"version":1,
         "site":{"id":"\#(siteID)","name":"Home","timezone":"UTC","localDate":"2026-09-23"},
         "live":{"solarPower":1,"loadPower":2,"batteryPower":3,"gridPower":4},
         "stateOfCharge":50,"activeTariff":"Peak",
         "today":{"homeKwh":1,"solarKwh":2,"gridNetKwh":3,"batteryNetKwh":4},
         "todayComplete":true,"currentBill":null,
         "sources":{"liveStatusAt":"2026-09-23T12:00:00Z","energyDataThrough":null,
                    "stateOfChargeAt":"\#(chargeAt)"}}
        """#
        return try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data(json.utf8))
    }

    private static func billResponse(siteID: String) throws -> MobileBillResponse {
        let json = #"""
        {"version":1,
         "site":{"id":"\#(siteID)","name":"Home","timezone":"UTC"},
         "currentBill":{"estimatedCost":42,"currency":"USD",
                        "cycleStart":"2026-09-01T00:00:00Z","cycleEnd":"2026-10-01T00:00:00Z",
                        "periods":[]},
         "sources":{"calculatedAt":"2026-09-23T12:00:00Z","energyDataThrough":null}}
        """#
        return try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(json.utf8))
    }

    private static func planningContextResponse(
        siteID: String,
        asOf: Date
    ) -> MobileLoadPlanningContextResponse {
        MobileLoadPlanningContextResponse(
            version: 1,
            site: .init(id: siteID, timezone: "UTC"),
            units: .init(power: "kW", localMinute: "minute-of-day"),
            asOf: asOf,
            availability: .available,
            unavailableReason: nil,
            usableDayCount: 14,
            historyStart: asOf.addingTimeInterval(-14 * 24 * 60 * 60),
            historyEnd: asOf.addingTimeInterval(-60),
            slots: (0 ..< 48).map { index in
                MobileLoadPlanningContextResponse.Slot(
                    localMinute: index * 30, homeKw: 1, batteryNetChargeKw: 0, sampleCount: 14, coverage: 1
                )
            }
        )
    }
}

@MainActor
final class FastDashboardAPISpy: MobileDashboardDataAPI, MobileLivePowerDataAPI {
    let summary = DashboardAPISpy()
    let now: () -> Date
    var powerSiteIDs: [String] = []
    var powerError: (any Error)?
    var holdPower = false
    var pendingPower: CheckedContinuation<MobileLivePowerResponse, any Error>?
    private var pendingSiteID: String?

    init(now: @escaping () -> Date) { self.now = now }

    func fetchLive(siteID: String) async throws -> MobileLiveResponse {
        try await summary.fetchLive(siteID: siteID)
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        try await summary.fetchBill(siteID: siteID)
    }

    func fetchLivePower(siteID: String) async throws -> MobileLivePowerResponse {
        powerSiteIDs.append(siteID)
        if let powerError { throw powerError }
        if holdPower {
            pendingSiteID = siteID
            return try await withCheckedThrowingContinuation { pendingPower = $0 }
        }
        return try response(siteID: siteID)
    }

    func resumePower() {
        let continuation = pendingPower
        pendingPower = nil
        do { continuation?.resume(returning: try response(siteID: pendingSiteID ?? "site-1")) } catch {
            continuation?.resume(throwing: error)
        }
    }

    private func response(siteID: String) throws -> MobileLivePowerResponse {
        let stamp = ISO8601DateFormatter().string(from: now())
        let json = """
        {"version":1,"siteID":"\(siteID)",
         "live":{"solarPower":4000,"loadPower":1000,"batteryPower":-3000,"gridPower":0},
         "stateOfCharge":75,"sources":{"liveStatusAt":"\(stamp)","stateOfChargeAt":"\(stamp)"}}
        """
        let instant = now()
        return try MobileContractDecoder.make(now: { instant }).decode(
            MobileLivePowerResponse.self, from: Data(json.utf8)
        )
    }
}
