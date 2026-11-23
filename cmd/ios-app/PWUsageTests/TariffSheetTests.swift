import Foundation
@testable import PWUsage
import PWUsageCore
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

    static let fixture = TariffTimelineFixture.json
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

    @Test("Mismatch banner says PWUsage's plan differs from the plan last saved from Tesla, and when")
    func divergenceCopyNamesTheNewerPlan() {
        func copy(ours: String?, theirs: String?) -> TeslaDivergenceCopy {
            TeslaDivergenceCopy(
                sync: TeslaSyncDTO(
                    latestTariffId: 1,
                    latestTariffName: "We energies",
                    latestUpdatedAt: theirs,
                    activeManualUpdatedAt: ours,
                    differsFromActiveManual: true, syncAvailable: false, syncUnavailableReason: nil, lastSync: nil
                )
            )
        }
        let dated = copy(ours: "2026-11-12T15:00:00Z", theirs: "2026-10-29T12:00:00Z")
        #expect(dated.title == "PWUsage’s rate plan differs from Tesla’s")
        #expect(dated.detail.hasPrefix("PWUsage last saved \"We energies\" from Tesla on Oct 29, 2026."))
        #expect(dated.detail.contains("Your Powerwall uses the plan in Tesla"))

        let undated = copy(ours: nil, theirs: nil)
        #expect(undated.title == "PWUsage’s rate plan differs from Tesla’s")
        #expect(undated.detail.hasPrefix("\"We energies\" is the plan PWUsage last saved from Tesla."))
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
    @Test("Editing one date range of a plan may keep the name its other ranges share")
    func editedPlanKeepsItsOwnName() throws {
        let timeline = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffSheetTests.fixture.utf8)
        )
        let residential = try #require(timeline.periods.first { $0.name == "Residential" })
        let fragment = TariffPeriodDTO(
            periodId: 9, tariffId: 99, name: " residential ", version: 3, source: .manual,
            effectiveFrom: "2024-01-01", effectiveTo: "2024-12-31", isCurrentToday: false,
            updatedBy: nil, seasons: residential.seasons
        )
        let periods = timeline.periods + [fragment]
        #expect(RatePlanEditorMode.edit(residential).takenNames(among: periods) == ["Tesla Plan"])
        #expect(RatePlanEditorMode.add.takenNames(among: periods).contains("Residential"))
    }

    @Test("Estimated plans do not reserve their names")
    func estimatedPlansDoNotReserveNames() throws {
        let timeline = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffSheetTests.fixture.utf8)
        )
        let residential = try #require(timeline.periods.first { $0.name == "Residential" })
        let estimate = TariffPeriodDTO(
            periodId: 10, tariffId: 100, name: "Residential Rg 1", version: 1, source: .estimated,
            effectiveFrom: "2022-01-01", effectiveTo: "2022-12-31", isCurrentToday: false,
            updatedBy: nil, seasons: residential.seasons
        )
        #expect(!RatePlanEditorMode.add.takenNames(among: timeline.periods + [estimate]).contains("Residential Rg 1"))
    }

    @Test("A season that starts mid-month is matched by day, not just month")
    func midMonthSeasonsMatchByDay() throws {
        let timeline = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffSheetTests.fixture.utf8)
        )
        let window = { (rate: Double) in
            [TimePeriodWindowInput(
                touName: .offPeak, fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: rate, sellRate: 0
            )]
        }
        func season(_ name: String, _ from: (Int, Int), _ end: (Int, Int), rate: Double) -> TariffSeasonInput {
            TariffSeasonInput(
                name: name, fromMonth: from.0, toMonth: end.0,
                weekdayPeriods: window(rate), weekendPeriods: window(rate), fromDay: from.1, toDay: end.1
            )
        }
        let plan = TariffPeriodDTO(
            periodId: 1, tariffId: 1, name: "Tesla", version: 1, source: .tesla,
            effectiveFrom: "2020-01-01", effectiveTo: nil, isCurrentToday: true, updatedBy: nil,
            seasons: [season("Early June", (6, 1), (6, 15), rate: 0.10), season("Rest", (6, 16), (5, 31), rate: 0.40)]
        )
        let mid = SiteTariffsTimelineResponse(
            version: 2, siteId: timeline.siteId, timezone: timeline.timezone, currency: "USD", periods: [plan],
            reattribution: nil, holidayDates: nil, teslaSync: timeline.teslaSync
        )
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: mid.timezone) ?? .gmt
        let june20 = try #require(calendar.date(from: DateComponents(year: 2026, month: 6, day: 20, hour: 12)))
        #expect(mid.activePeriodNow(at: june20)?.window.buyRate == 0.40)
        let june10 = try #require(calendar.date(from: DateComponents(year: 2026, month: 6, day: 10, hour: 12)))
        #expect(mid.activePeriodNow(at: june10)?.window.buyRate == 0.10)
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
