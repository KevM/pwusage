import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Solar Forecast Coordinator Tests", .serialized)
struct SolarForecastCoordinatorTests {
    @Test("Billing loads history without live Tesla refresh and reuses planning context")
    func billingReusesPlanningContext() async {
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            accountScopeID: "local-account", now: { api.now }, timerInterval: nil
        )
        await coordinator.billOutlookAppeared()
        await coordinator.billOutlookAppeared()
        #expect(api.billSiteIDs == ["site-a"])
        #expect(api.contextSiteIDs == ["site-a"])
        #expect(api.liveSiteIDs.isEmpty)
    }

    @Test("Unconfigured detail keeps basic estimate and performs no forecast-only requests")
    func unconfiguredDetailMakesNoForecastRequests() async {
        let api = ForecastDashboardAPISpy()
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .basic)
        #expect(api.contextSiteIDs == ["site-a"])
        #expect(api.billSiteIDs == ["site-a"])
        #expect(api.liveSiteIDs.isEmpty)
    }

    @Test("Aging energy data waits for the usual bill cadence")
    func agingEnergyDataWithoutForecastKeepsTheCadence() async {
        let clock = ForecastTestClock()
        let api = ForecastDashboardAPISpy(now: clock.now)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            accountScopeID: "local-account",
            now: { clock.now }, timerInterval: nil
        )
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.refreshDue()
        #expect(api.billSiteIDs.count == 1)

        clock.advance(seconds: 16 * 60)
        await coordinator.refreshDue()
        #expect(api.billSiteIDs.count == 1)
    }

    @Test("Household pattern loads without forecast")
    func householdPatternLoadsWithoutForecast() async {
        let clock = ForecastTestClock()
        let api = ForecastDashboardAPISpy(now: clock.now)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            accountScopeID: "local-account",
            now: { clock.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.householdPattern != nil)
        #expect(coordinator.householdPattern?.timeZone == "UTC")
        #expect(coordinator.loadPlanningContext == nil)
    }

    @Test("Fresh validated context is reused for twenty four hours")
    func contextIsCachedForTwentyFourHours() async {
        let clock = ForecastTestClock()
        let api = ForecastDashboardAPISpy(now: clock.now)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            accountScopeID: "local-account",
            now: { clock.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()
        clock.advance(hours: 23)
        await coordinator.loadTimingDetailAppeared()
        #expect(api.contextSiteIDs == ["site-a"])
        clock.advance(hours: 2)
        await coordinator.loadTimingDetailAppeared()
        #expect(api.contextSiteIDs == ["site-a", "site-a"])
    }

    @Test("Context failure or mismatched site keeps the basic estimate")
    func unusableContextKeepsBasicEstimate() async {
        let api = ForecastDashboardAPISpy()
        api.contextResponseSiteID = "site-b"
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .basic)
        #expect(coordinator.householdPattern == nil)
    }

    @Test("Stale context keeps the basic estimate")
    func staleContextKeepsBasicEstimate() async {
        let api = ForecastDashboardAPISpy()
        api.contextAsOf = api.now.addingTimeInterval(-25 * 60 * 60)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastState == .basic)
        #expect(coordinator.householdPattern == nil)
    }

    @Test("Planning context is validated at receive time and permits an hour of source clock skew")
    func contextUsesReceiveTimeForValidation() async {
        let clock = ForecastTestClock()
        let api = ForecastDashboardAPISpy(now: clock.now)
        api.contextAsOf = clock.now.addingTimeInterval(60)
        api.beforeContextResponse = { clock.advance(seconds: 120) }
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            accountScopeID: "local-account",
            now: { clock.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.householdPattern != nil)
    }

    @Test("Planning context more than an hour in the future is rejected")
    func contextRejectsExcessiveFutureSkew() async {
        let api = ForecastDashboardAPISpy()
        api.contextAsOf = api.now.addingTimeInterval(60 * 60 + 1)
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.householdPattern == nil)
    }

    @Test("Planning context without five usable day votes and sufficient coverage is rejected")
    func contextRejectsInsufficientVotes() async {
        let api = ForecastDashboardAPISpy()
        api.contextUsableDayCount = 4
        api.contextSampleCount = 4
        api.contextCoverage = 0.89
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.householdPattern == nil)
    }

    @Test("Simultaneous detail appearances share one planning context request")
    func simultaneousDetailsDeduplicateContext() async throws {
        let api = ForecastDashboardAPISpy()
        api.holdContextResponses = true
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        let first = Task { await coordinator.loadTimingDetailAppeared() }
        let second = Task { await coordinator.loadTimingDetailAppeared() }
        try await waitUntil { !api.contextSiteIDs.isEmpty }
        for _ in 0 ..< 20 { await Task.yield() }

        #expect(api.contextSiteIDs.count == 1)
        api.resumeContextResponses()
        await first.value
        await second.value
    }

    @Test("A failed shared planning context request is removed so a later detail can retry")
    func failedContextCanRetry() async {
        let api = ForecastDashboardAPISpy()
        api.contextError = PWUsageAPIError.invalidResponse
        let coordinator = DashboardCoordinator(
            siteID: "site-a", api: api, planningAPI: api,
            accountScopeID: "local-account",
            now: { api.now }, timerInterval: nil
        )

        await coordinator.loadTimingDetailAppeared()
        #expect(coordinator.householdPattern == nil)
        api.contextError = nil
        api.now = api.now.addingTimeInterval(6 * 60)
        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.householdPattern != nil)
        #expect(api.contextSiteIDs == ["site-a", "site-a"])
    }

    @Test("Context errors map distinctly to unavailable reasons")
    func contextErrorsMapDistinctly() async {
        func reason(
            error: Error? = nil, unavailable: Bool = false, reasonText: String? = nil
        ) async -> SolarForecastUnavailableReason? {
            let api = ForecastDashboardAPISpy()
            api.contextError = error
            api.contextIsUnavailable = unavailable
            api.contextUnavailableReason = reasonText
            let coordinator = DashboardCoordinator(
                siteID: "site-a", api: api, planningAPI: api,
                accountScopeID: "local-account", now: { api.now }, timerInterval: nil
            )
            return await coordinator.planningContext(siteID: "site-a", api: api).unavailableReason
        }

        #expect(await reason(error: PWUsageAPIError.recoverableServerError(statusCode: 500)) == .requestFailed)
        #expect(await reason(error: MobileLoadPlanningContextResponse.ContractError.invalidSource) == .contextMalformed)
        #expect(await reason(error: MobileLoadPlanningContextResponse.ContractError.timestampSkew) == .contextInvalid)
        #expect(await reason(error: PWUsageAPIError.requestRejected(statusCode: 404, message: nil)) == .serverOutdated)
        #expect(await reason(unavailable: true, reasonText: "timestamp-misaligned") == .timestampMisaligned)
        #expect(await reason(unavailable: true, reasonText: "insufficient-history") == .insufficientHistory)
        #expect(await reason(unavailable: true) == .contextUnavailable)
    }
}

private final class ForecastTestClock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
    func advance(hours: Double) { now = now.addingTimeInterval(hours * 3_600) }
    func advance(seconds: Double) { now = now.addingTimeInterval(seconds) }
}

extension MobileLoadPlanningContextResponse {
    static func fixture(
        siteID: String,
        timeZone: String = "UTC",
        asOf: Date,
        usableDayCount: Int = 14,
        sampleCount: Int = 14,
        coverage: Double = 1,
        availability: MobileLoadPlanningContextResponse.Availability = .available,
        unavailableReason: String? = nil
    ) -> Self {
        Self(
            version: 1,
            site: Site(id: siteID, timezone: timeZone),
            units: Units(power: "kW", localMinute: "minute-of-day"),
            asOf: asOf,
            availability: availability,
            unavailableReason: unavailableReason,
            usableDayCount: usableDayCount,
            historyStart: asOf.addingTimeInterval(-14 * 24 * 60 * 60),
            historyEnd: asOf.addingTimeInterval(-60),
            slots: (0 ..< 48).map {
                Slot(localMinute: $0 * 30, homeKw: 1, batteryNetChargeKw: 0, sampleCount: sampleCount,
                     coverage: coverage)
            }
        )
    }
}

@MainActor
private final class ForecastDashboardAPISpy: MobileDashboardDataAPI, MobileLoadPlanningDataAPI {
    var liveSiteIDs: [String] = []
    var billSiteIDs: [String] = []
    var contextSiteIDs: [String] = []
    var contextResponseSiteID = "site-a"
    var contextTimeZone = "UTC"
    var billTimeZone = "UTC"
    var energyDataThrough = "2027-01-15T07:55:00Z"
    var now: Date
    var contextAsOf: Date?
    var contextUsableDayCount = 14
    var contextSampleCount = 14
    var contextCoverage = 1.0
    var contextIsUnavailable = false
    var contextUnavailableReason: String?
    var beforeContextResponse: (() -> Void)?
    var holdContextResponses = false
    var billError: Error?
    var contextError: Error?
    private var contextContinuations: [CheckedContinuation<Void, Never>] = []

    init(now: Date = Date(timeIntervalSince1970: 1_800_000_000)) { self.now = now }

    func fetchLive(siteID: String) async throws -> MobileLiveResponse {
        liveSiteIDs.append(siteID)
        throw PWUsageAPIError.invalidResponse
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        billSiteIDs.append(siteID)
        if let billError { throw billError }
        let json = #"""
        {"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"\#(billTimeZone)"},
        "currentBill":{"estimatedCost":1,"currency":"USD","cycleStart":"2026-01-01T00:00:00Z",
        "cycleEnd":"2030-01-01T00:00:00Z","periods":[]},
        "sources":{"calculatedAt":"2027-01-15T08:00:00Z","energyDataThrough":"\#(energyDataThrough)"}}
        """#
        return try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(json.utf8))
    }

    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        contextSiteIDs.append(siteID)
        if holdContextResponses { await withCheckedContinuation { contextContinuations.append($0) } }
        if let contextError { throw contextError }
        beforeContextResponse?()
        return MobileLoadPlanningContextResponse.fixture(
            siteID: contextResponseSiteID,
            timeZone: contextTimeZone,
            asOf: contextAsOf ?? now,
            usableDayCount: contextIsUnavailable ? 2 : contextUsableDayCount,
            sampleCount: contextSampleCount,
            coverage: contextCoverage,
            availability: contextIsUnavailable ? .unavailable : .available,
            unavailableReason: contextUnavailableReason
        )
    }

    func resumeContextResponses() {
        holdContextResponses = false
        let pending = contextContinuations
        contextContinuations.removeAll()
        pending.forEach { $0.resume() }
    }
}

@MainActor
private func waitUntil(_ condition: () -> Bool) async throws {
    for _ in 0 ..< 100 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("Timed out waiting for coordinator test condition")
}
