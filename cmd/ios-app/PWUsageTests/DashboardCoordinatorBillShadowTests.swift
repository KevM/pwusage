import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("DashboardCoordinatorBillShadowTests")
struct DashboardCoordinatorBillShadowTests {
    private let scope = SolarForecastSiteScope(accountScopeID: "acct-1", siteID: "site-fixture")

    private struct TestStores {
        let history: SolarHistoryStore
        let timelines: RatePlanTimelineStore
        let folder: URL
    }

    private func makeStores() -> TestStores {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("bill-shadow-\(UUID().uuidString)")
        let history = SolarHistoryStore(directory: folder.appendingPathComponent("history"))
        let timelines = RatePlanTimelineStore(directory: folder.appendingPathComponent("timelines"))
        return TestStores(history: history, timelines: timelines, folder: folder)
    }

    private func seedFlows(in store: SolarHistoryStore, fixture: BillPricingFixture) async throws {
        let timeZone = try #require(TimeZone(identifier: fixture.timeline.timezone))
        let historyDays = fixture.days.map { day in
            let slotCount = day.gridWh.count
            return MobileSolarHistoryDay(
                day: day.day,
                dayStart: day.dayStart,
                status: .complete,
                fetchedAt: day.dayStart,
                solarWh: day.solarWh.map { $0.map(Double.init) },
                loadWh: day.loadWh.map { $0.map(Double.init) },
                gridWh: day.gridWh.map { $0.map(Double.init) },
                batteryWh: Array(repeating: Double?(0), count: slotCount),
                batterySoc: Array(repeating: Double?.none, count: slotCount)
            )
        }
        let fill = MobileSolarHistoryFill(
            timeZone: timeZone,
            status: .complete,
            historyStart: historyDays.first?.day ?? "2026-01-01",
            days: historyDays
        )
        try await store.merge(fill, scope: scope)
    }

    private func makeServerBill(
        fixture: BillPricingFixture,
        estimatedCost: Double,
        reattribution: ReattributionStatusDTO? = nil
    ) -> MobileBillResponse {
        MobileBillResponse(
            version: 1,
            site: MobileBillResponse.Site(
                id: fixture.timeline.siteId,
                name: "Home",
                timezone: fixture.timeline.timezone
            ),
            currentBill: MobileBillResponse.Bill(
                estimatedCost: estimatedCost,
                currency: fixture.timeline.currency,
                cycleStart: fixture.expected.currentBill.cycleStart,
                cycleEnd: fixture.expected.currentBill.cycleEnd,
                periods: [
                    Period(tariffName: "Utility", periodName: "Peak", netGridKwh: 10, cost: estimatedCost)
                ]
            ),
            loadTiming: nil,
            tariffReattribution: reattribution,
            sources: MobileBillResponse.Sources(calculatedAt: fixture.now, energyDataThrough: nil)
        )
    }

    @Test("Shadow mode shows server bill and reports difference once per cycle")
    func shadowShowsServerBillAndReportsDifference() async throws {
        let stores = makeStores()
        defer { try? FileManager.default.removeItem(at: stores.folder) }

        let fixture = try BillPricingFixture.load("single-plan-cycle")
        try await seedFlows(in: stores.history, fixture: fixture)
        try await stores.timelines.save(fixture.timeline, etag: "etag-1", scope: scope)

        let api = BillShadowAPISpy(
            bill: makeServerBill(fixture: fixture, estimatedCost: 999.99),
            timeline: fixture.timeline
        )
        let coordinator = DashboardCoordinator(
            siteID: fixture.timeline.siteId,
            api: api,
            accountScopeID: scope.accountScopeID,
            now: { fixture.now },
            timerInterval: nil,
            history: stores.history,
            ratePlanTimelines: stores.timelines,
            billPricingMode: .shadow
        )
        coordinator.billingDay = fixture.billingDay

        await coordinator.refreshBill(trigger: .userGesture)

        #expect(coordinator.bill.response?.currentBill.estimatedCost == 999.99)
        try await eventually { api.shadowReports.count == 1 }
        #expect(api.shadowReports.first?.siteId == fixture.timeline.siteId)

        await coordinator.refreshBill(trigger: .userGesture)
        try await staysTrue { api.shadowReports.count == 1 }
    }

    @Test("Shadow mode skips comparison while tariff reattribution is running")
    func shadowSkipsWhileReattributionRuns() async throws {
        let stores = makeStores()
        defer { try? FileManager.default.removeItem(at: stores.folder) }

        let fixture = try BillPricingFixture.load("single-plan-cycle")
        try await seedFlows(in: stores.history, fixture: fixture)
        try await stores.timelines.save(fixture.timeline, etag: "etag-1", scope: scope)

        let running = ReattributionStatusDTO(
            status: .running,
            fromDate: "2026-01-01",
            toDate: nil,
            totalDays: 5,
            processedDays: 1,
            updatedDays: 1,
            lastError: nil,
            updatedAt: "2026-09-23T10:00:00Z"
        )
        let api = BillShadowAPISpy(
            bill: makeServerBill(fixture: fixture, estimatedCost: 999.99, reattribution: running),
            timeline: fixture.timeline
        )
        let coordinator = DashboardCoordinator(
            siteID: fixture.timeline.siteId,
            api: api,
            accountScopeID: scope.accountScopeID,
            now: { fixture.now },
            timerInterval: nil,
            history: stores.history,
            ratePlanTimelines: stores.timelines,
            billPricingMode: .shadow
        )
        coordinator.billingDay = fixture.billingDay

        await coordinator.refreshBill(trigger: .userGesture)

        #expect(coordinator.bill.response?.currentBill.estimatedCost == 999.99)
        try await staysTrue { api.shadowReports.isEmpty }
    }

    @Test("Shadow mode skips comparison when local bill is not ready")
    func shadowSkipsWhenLocalNotReady() async throws {
        let stores = makeStores()
        defer { try? FileManager.default.removeItem(at: stores.folder) }

        let fixture = try BillPricingFixture.load("single-plan-cycle")
        // No saved timeline and no flows: LocalBillBuilder returns .notReady(.noTimeline).

        let api = BillShadowAPISpy(
            bill: makeServerBill(fixture: fixture, estimatedCost: 999.99),
            timeline: fixture.timeline
        )
        let coordinator = DashboardCoordinator(
            siteID: fixture.timeline.siteId,
            api: api,
            accountScopeID: scope.accountScopeID,
            now: { fixture.now },
            timerInterval: nil,
            history: stores.history,
            ratePlanTimelines: stores.timelines,
            billPricingMode: .shadow
        )
        coordinator.billingDay = fixture.billingDay

        await coordinator.refreshBill(trigger: .userGesture)

        #expect(coordinator.bill.response?.currentBill.estimatedCost == 999.99)
        try await staysTrue { api.shadowReports.isEmpty }
    }

    @Test("Server mode never builds locally or reports shadow differences")
    func serverModeNeverBuildsLocally() async throws {
        let stores = makeStores()
        defer { try? FileManager.default.removeItem(at: stores.folder) }

        let fixture = try BillPricingFixture.load("single-plan-cycle")
        try await seedFlows(in: stores.history, fixture: fixture)
        try await stores.timelines.save(fixture.timeline, etag: "etag-1", scope: scope)

        let api = BillShadowAPISpy(
            bill: makeServerBill(fixture: fixture, estimatedCost: 999.99),
            timeline: fixture.timeline
        )
        let coordinator = DashboardCoordinator(
            siteID: fixture.timeline.siteId,
            api: api,
            accountScopeID: scope.accountScopeID,
            now: { fixture.now },
            timerInterval: nil,
            history: stores.history,
            ratePlanTimelines: stores.timelines,
            billPricingMode: .server
        )
        coordinator.billingDay = fixture.billingDay

        await coordinator.refreshBill(trigger: .userGesture)

        #expect(coordinator.bill.response?.currentBill.estimatedCost == 999.99)
        try await staysTrue { api.shadowReports.isEmpty && api.timelineFetchCount == 0 }
    }
}

@MainActor
private final class BillShadowAPISpy: MobileDashboardDataAPI, MobileTariffDataAPI, MobileBillShadowAPI {
    let bill: MobileBillResponse
    let timeline: SiteTariffsTimelineResponse
    var shadowReports: [BillShadowReport] = []
    var timelineFetchCount = 0

    init(bill: MobileBillResponse, timeline: SiteTariffsTimelineResponse) {
        self.bill = bill
        self.timeline = timeline
    }

    func fetchLive(siteID: String, refresh: Bool) async throws -> MobileLiveResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        bill
    }

    func fetchTariffTimeline(siteID: String) async throws -> SiteTariffsTimelineResponse {
        timelineFetchCount += 1
        return timeline
    }

    func fetchTariffTimeline(siteID: String, knownETag: String?) async throws -> TimelineFetch {
        timelineFetchCount += 1
        return .unchanged
    }

    func refreshTariffsFromTesla(siteID: String) async throws -> SiteTariffsTimelineResponse {
        timeline
    }

    func createTariffPeriod(siteID: String, body: TariffPlanWriteRequest) async throws -> SiteTariffsTimelineResponse {
        timeline
    }

    func updateTariffPeriod(
        siteID: String, periodID: Int, body: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse {
        timeline
    }

    func deleteTariffPeriod(siteID: String, periodID: Int) async throws -> SiteTariffsTimelineResponse {
        timeline
    }

    func retryTariffReattribution(siteID: String) async throws -> SiteTariffsTimelineResponse {
        timeline
    }

    func reportBillShadow(_ report: BillShadowReport) async throws {
        shadowReports.append(report)
    }
}
