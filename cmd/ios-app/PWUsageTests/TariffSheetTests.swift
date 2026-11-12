import Foundation
@testable import PWUsage
import Testing

@Suite("Tariff sheet")
struct TariffSheetTests {
    @Test("Decodes v2 timeline periods, updatedBy attribution, reattribution, and teslaSync")
    func decodesV2TimelineResponse() throws {
        let response = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(Self.fixture.utf8)
        )
        #expect(response.version == 2)
        #expect(response.periods.count == 2)
        #expect(response.periods[0].source == .manual)
        #expect(response.periods[0].updatedBy?.email == "owner@example.com")
        #expect(response.periods[0].updatedBy?.isCurrentUser == true)
        #expect(response.periods[0].seasons[0].weekdayPeriods[0].buyRate == 0.30335)
        #expect(response.reattribution?.status == .running)
        #expect(response.reattribution?.processedDays == 40)
        #expect(response.teslaSync.differsFromActiveManual == true)
    }

    @Test("Rejects wrong site and non-v2 timeline version")
    func rejectsWrongSiteAndVersion() throws {
        let response = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(Self.fixture.utf8)
        )
        #expect(throws: PWUsageAPIError.invalidResponse) { _ = try response.validating(siteID: "other") }
        #expect(throws: PWUsageAPIError.invalidResponse) {
            let version1 = Self.fixture.replacingOccurrences(of: "\"version\":2", with: "\"version\":1")
            _ = try MobileContractDecoder.make().decode(
                SiteTariffsTimelineResponse.self,
                from: Data(version1.utf8)
            )
            .validating(siteID: "a")
        }
    }

    @Test("Computes explicit timeline gap label between non-adjacent rate periods")
    func computesTimelineGapLabelBetweenNonAdjacentPeriods() {
        let older = TariffPeriodDTO(
            periodId: 1,
            tariffId: 10,
            name: "Prior Plan",
            version: 1,
            source: .tesla,
            effectiveFrom: "2025-01-01",
            effectiveTo: "2025-09-30",
            isCurrentToday: false,
            updatedBy: nil,
            seasons: []
        )
        let newer = TariffPeriodDTO(
            periodId: 2,
            tariffId: 20,
            name: "Current Plan",
            version: 1,
            source: .manual,
            effectiveFrom: "2026-01-01",
            effectiveTo: nil,
            isCurrentToday: true,
            updatedBy: nil,
            seasons: []
        )
        let gap = RatePlanTimelineFormatting.gapDescription(newer: newer, older: older)
        #expect(gap == "Oct 1, 2025 – Dec 31, 2025 · Uses nearest prior plan")
    }

    static let fixture = #"{"version":2,"siteId":"a","timezone":"America/Chicago","currency":"USD","periods":["#
        + #"{"periodId":2,"tariffId":20,"name":"Residential","version":2,"source":"manual","#
        + #""effectiveFrom":"2026-01-01","effectiveTo":null,"isCurrentToday":true,"#
        + #""updatedBy":{"email":"owner@example.com","isCurrentUser":true},"#
        + #""seasons":[{"name":"Winter","fromMonth":10,"toMonth":4,"weekdayPeriods":["#
        + #"{"touName":"ON_PEAK","fromHour":8,"fromMinute":0,"toHour":20,"toMinute":0,"#
        + #""buyRate":0.30335,"sellRate":0.04906},"#
        + #"{"touName":"OFF_PEAK","fromHour":20,"fromMinute":0,"toHour":8,"toMinute":0,"#
        + #""buyRate":0.10,"sellRate":0.0329}],"weekendPeriods":["#
        + #"{"touName":"OFF_PEAK","fromHour":0,"fromMinute":0,"toHour":24,"toMinute":0,"#
        + #""buyRate":0.10,"sellRate":0.0329}]}]},"#
        + #"{"periodId":1,"tariffId":10,"name":"Tesla Plan","version":1,"source":"tesla","#
        + #""effectiveFrom":"2025-01-01","effectiveTo":"2025-12-31","isCurrentToday":false,"#
        + #""updatedBy":null,"seasons":[{"name":"All Year","fromMonth":1,"toMonth":12,"weekdayPeriods":["#
        + #"{"touName":"OFF_PEAK","fromHour":0,"fromMinute":0,"toHour":24,"toMinute":0,"#
        + #""buyRate":0.20,"sellRate":0.05}],"weekendPeriods":["#
        + #"{"touName":"OFF_PEAK","fromHour":0,"fromMinute":0,"toHour":24,"toMinute":0,"#
        + #""buyRate":0.20,"sellRate":0.05}]}]}],"#
        + #""reattribution":{"status":"running","fromDate":"2026-01-01","toDate":null,"#
        + #""totalDays":100,"processedDays":40,"updatedDays":25,"lastError":null,"#
        + #""updatedAt":"2026-10-01T13:00:00Z"},"#
        + #""teslaSync":{"latestTariffId":10,"latestTariffName":"Tesla Plan","#
        + #""latestUpdatedAt":"2026-10-01T12:00:00Z","differsFromActiveManual":true}}"#
}

@MainActor
@Suite("Tariff authorization")
struct TariffAuthorizationTests {
    @Test func requiresVerifiedSession() async throws {
        let api = TariffTestAPI()
        let coordinator = DashboardCoordinator(siteID: "a", api: api, timerInterval: nil)
        coordinator.restoreLaunchCache(nil, sessionVerified: false)
        await #expect(throws: PWUsageAPIError.signInRequired) { try await coordinator.fetchTariffTimeline() }
        #expect(api.calls == 0)
        coordinator.authenticationRestored()
        _ = try await coordinator.fetchTariffTimeline()
        #expect(api.calls == 1)
        coordinator.authenticationInvalidated()
        await #expect(throws: PWUsageAPIError.signInRequired) { try await coordinator.fetchTariffTimeline() }
        #expect(api.calls == 1)
    }

    @Test func discardsResponseAfterSiteSwitch() async throws {
        let api = TariffTestAPI()
        let coordinator = DashboardCoordinator(siteID: "a", api: api, timerInterval: nil)
        coordinator.authenticationRestored()
        api.beforeReturn = { coordinator.selectSite("b") }
        await #expect(throws: CancellationError.self) { try await coordinator.fetchTariffTimeline() }
    }

    @Test func unauthorizedResponseInvalidatesSession() async throws {
        let api = TariffTestAPI()
        let coordinator = DashboardCoordinator(siteID: "a", api: api, timerInterval: nil)
        coordinator.authenticationRestored()
        api.error = .signInRequired
        await #expect(throws: PWUsageAPIError.signInRequired) { try await coordinator.fetchTariffTimeline() }
        #expect(coordinator.requiresSignIn)
    }
}

@MainActor
private final class TariffTestAPI: MobileDashboardDataAPI, MobileTariffDataAPI {
    var calls = 0
    var beforeReturn: (() -> Void)?
    var error: PWUsageAPIError?

    func fetchTariffTimeline(siteID: String) async throws -> SiteTariffsTimelineResponse {
        calls += 1
        if let error { throw error }
        beforeReturn?()
        return try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffSheetTests.fixture.utf8)
        )
    }

    func refreshTariffsFromTesla(siteID: String) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func createTariffPeriod(
        siteID: String,
        body: TariffPlanWriteRequest
    ) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func updateTariffPeriod(
        siteID: String,
        periodID: Int,
        body: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func deleteTariffPeriod(siteID: String, periodID: Int) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func retryTariffReattribution(siteID: String) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func fetchLive(siteID: String, refresh: Bool) async throws -> MobileLiveResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse { throw PWUsageAPIError.invalidResponse }

    @Test("Divergence banner says which plan is newer")
    func divergenceCopyNamesTheNewerPlan() {
        func copy(ours: String?, theirs: String?) -> TeslaDivergenceCopy {
            TeslaDivergenceCopy(
                sync: TeslaSyncDTO(
                    latestTariffId: 1,
                    latestTariffName: "We energies",
                    latestUpdatedAt: theirs,
                    activeManualUpdatedAt: ours,
                    differsFromActiveManual: true
                )
            )
        }
        let newer = copy(ours: "2026-11-12T15:00:00Z", theirs: "2026-10-29T12:00:00Z")
        #expect(newer.title == "Your custom plan is newer than Tesla's")
        #expect(newer.detail.contains("hasn't changed since"))
        #expect(newer.detail.contains("2026"))

        let older = copy(ours: "2026-10-01T15:00:00Z", theirs: "2026-11-02T12:00:00Z")
        #expect(older.title == "Tesla changed its plan after your custom plan")

        #expect(copy(ours: nil, theirs: nil).title == "Tesla's plan differs from your custom plan")
    }

    @Test("Sync reports what it found even when nothing changes on screen")
    func syncNoticeDescribesTheOutcome() throws {
        let timeline = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffSheetTests.fixture.utf8)
        )
        let same = TeslaDivergenceCopy.syncNotice(
            previousTeslaPlan: timeline.teslaSync.latestTariffId,
            refreshed: timeline
        )
        #expect(same.hasPrefix("Checked Tesla"))
        let changed = TeslaDivergenceCopy.syncNotice(previousTeslaPlan: -1, refreshed: timeline)
        #expect(changed.contains("saved to your history") || changed.contains("Saved Tesla's updated plan"))
    }

    @Test("A weekday holiday uses the weekend schedule for the active rate")
    func holidayUsesWeekendSchedule() throws {
        var timeline = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffSheetTests.fixture.utf8)
        )
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: timeline.timezone) ?? .gmt
        // Thursday 26 Nov 2026, noon: the fixture's weekday schedule is Peak 8 AM - 8 PM.
        let noon = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 26, hour: 12)))
        #expect(timeline.activePeriodNow(at: noon)?.window.touName == .onPeak)
        timeline.holidayDates = ["2026-11-26"]
        #expect(timeline.activePeriodNow(at: noon)?.window.touName == .offPeak)
    }
    @Test("In a gap the active rate comes from the nearest earlier plan, and before every plan from the earliest")
    func gapFallsBackLikeTheServer() throws {
        var timeline = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffSheetTests.fixture.utf8)
        )
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: timeline.timezone) ?? .gmt
        // Fixture plans: 2025 and 2026-ongoing. End the newer one so mid-February is in a gap (Winter covers it).
        let ended = timeline.periods.map { period -> TariffPeriodDTO in
            guard period.effectiveTo == nil else { return period }
            return TariffPeriodDTO(
                periodId: period.periodId, tariffId: period.tariffId, name: period.name, version: period.version,
                source: period.source, effectiveFrom: period.effectiveFrom, effectiveTo: "2026-01-31",
                isCurrentToday: false, updatedBy: period.updatedBy, seasons: period.seasons
            )
        }
        timeline = SiteTariffsTimelineResponse(
            version: timeline.version, siteId: timeline.siteId, timezone: timeline.timezone,
            currency: timeline.currency, periods: ended, reattribution: timeline.reattribution,
            holidayDates: nil, teslaSync: timeline.teslaSync
        )
        let inGap = try #require(calendar.date(from: DateComponents(year: 2026, month: 2, day: 10, hour: 12)))
        #expect(timeline.activePeriodNow(at: inGap)?.period.effectiveFrom == "2026-01-01")
        let beforeAll = try #require(calendar.date(from: DateComponents(year: 2024, month: 6, day: 10, hour: 12)))
        #expect(timeline.activePeriodNow(at: beforeAll)?.period.effectiveFrom == "2025-01-01")
    }
}
