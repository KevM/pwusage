import Foundation
import PWUsageCore

/// Answers every request the demo makes from memory: no network, no account,
/// nothing stored. The battery hold is simulated so the one interactive action
/// behaves like the real one, and ends with the demo.
@MainActor
final class DemoAPI: PWUsageApplicationAPI, MobileBatteryHoldDataAPI, MobileTariffDataAPI, MobileSolarHistoryDataAPI {
    /// How long one source instant serves before the next fetch moves it up to
    /// the clock. Long enough that a refresh's fetches agree, short enough that
    /// a long session stays inside the balance freshness windows.
    static let sourceLifetime: TimeInterval = 10 * 60

    /// The demo data's source instant, shared by every fetch until it is
    /// `sourceLifetime` old. Two minutes back: minute timelines render with the
    /// minute's start, so a source inside it would read as in the future.
    private(set) var launchedAt: Date
    let now: () -> Date
    private var hold: BatteryHold?
    private var nextHoldID = 1
    var demoTimeline: SiteTariffsTimelineResponse?
    var nextPeriodID = 100
    var billingDayOverride: Int?

    init(now: @escaping () -> Date = Date.init) {
        self.now = now
        launchedAt = Self.source(at: now())
    }

    private static func source(at date: Date) -> Date {
        Date(timeIntervalSince1970: floor(date.timeIntervalSince1970) - 120)
    }

    func currentSource() -> Date {
        let date = now()
        if date.timeIntervalSince(launchedAt) > Self.sourceLifetime { launchedAt = Self.source(at: date) }
        return launchedAt
    }

    func fetchSites() async throws -> [MobileSite] {
        guard let billingDayOverride else { return [DemoFixtures.site] }
        return [DemoFixtures.site.settingBillingDay(billingDayOverride)]
    }

    func fetchLive(siteID: String, refresh: Bool) async throws -> MobileLiveResponse {
        try DemoFixtures.live(asOf: currentSource(), billingDay: billingDayOverride)
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        try DemoFixtures.bill(asOf: currentSource(), billingDay: billingDayOverride)
    }

    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        DemoFixtures.planningContext(asOf: currentSource())
    }

    func searchUtilities(siteID _: String, query: String) async throws -> [String] {
        [DemoFixtures.site.utility].filter { $0.localizedCaseInsensitiveContains(query) }
    }

    func setUtility(siteID: String, name _: String) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func skipUtility(siteID: String) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func utilityPlans(siteID _: String) async throws -> [UtilityPlanDTO] { [] }

    func setUtilityPlan(siteID: String, label _: String) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func rateHistory(siteID _: String) async throws -> RatePlanHistoryDTO {
        DemoFixtures.rateHistory(asOf: now())
    }

    func saveRateHistory(
        siteID: String,
        periods _: [RatePlanHistoryPeriod]
    ) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func fetchTariffTimeline(siteID: String) async throws -> SiteTariffsTimelineResponse {
        let current = demoTimeline ?? DemoFixtures.tariffs(asOf: now())
        demoTimeline = current
        return current
    }

    func refreshTariffsFromTesla(siteID: String) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func createTariffPeriod(
        siteID: String,
        body: TariffPlanWriteRequest
    ) async throws -> SiteTariffsTimelineResponse {
        var current = try await fetchTariffTimeline(siteID: siteID)
        nextPeriodID += 1
        let created = TariffPeriodDTO(
            periodId: nextPeriodID,
            tariffId: nextPeriodID * 10,
            name: body.name,
            version: 1,
            source: .manual,
            effectiveFrom: body.effectiveFrom,
            effectiveTo: body.effectiveTo,
            isCurrentToday: body.effectiveTo == nil,
            updatedBy: TariffUpdatedByDTO(email: nil, isCurrentUser: true),
            seasons: body.seasons
        )
        let periods = ([created] + current.periods).sorted { $0.effectiveFrom > $1.effectiveFrom }
        current = SiteTariffsTimelineResponse(
            version: 2,
            siteId: current.siteId,
            timezone: current.timezone,
            currency: current.currency,
            periods: periods,
            reattribution: current.reattribution,
            teslaSync: current.teslaSync,
            systemCosts: current.systemCosts
        )
        demoTimeline = current
        return current
    }

    func updateTariffPeriod(
        siteID: String,
        periodID: Int,
        body: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse {
        let current = try await fetchTariffTimeline(siteID: siteID)
        let updatedPeriods = current.periods.map { period -> TariffPeriodDTO in
            guard period.periodId == periodID else { return period }
            let nextTo: String? = switch body.effectiveTo {
            case .unchanged: period.effectiveTo
            case .set(let date): date
            }
            return TariffPeriodDTO(
                periodId: period.periodId,
                tariffId: period.tariffId + 1,
                name: body.name ?? period.name,
                version: period.version + 1,
                source: period.source == .estimated ? .manual : period.source,
                effectiveFrom: body.effectiveFrom ?? period.effectiveFrom,
                effectiveTo: nextTo,
                isCurrentToday: period.isCurrentToday,
                updatedBy: TariffUpdatedByDTO(email: nil, isCurrentUser: true),
                seasons: body.seasons ?? period.seasons
            )
        }
        let next = SiteTariffsTimelineResponse(
            version: 2,
            siteId: current.siteId,
            timezone: current.timezone,
            currency: current.currency,
            periods: updatedPeriods.sorted { $0.effectiveFrom > $1.effectiveFrom },
            reattribution: current.reattribution,
            teslaSync: current.teslaSync,
            systemCosts: current.systemCosts
        )
        demoTimeline = next
        return next
    }

    func deleteTariffPeriod(siteID: String, periodID: Int) async throws -> SiteTariffsTimelineResponse {
        let current = try await fetchTariffTimeline(siteID: siteID)
        let remaining = current.periods.filter { $0.periodId != periodID }
        let next = SiteTariffsTimelineResponse(
            version: 2,
            siteId: current.siteId,
            timezone: current.timezone,
            currency: current.currency,
            periods: remaining,
            reattribution: current.reattribution,
            teslaSync: current.teslaSync,
            systemCosts: current.systemCosts
        )
        demoTimeline = next
        return next
    }

    func retryTariffReattribution(siteID: String) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func saveSystemCosts(siteID: String, body: SystemCostsWriteRequest) async throws -> SiteTariffsTimelineResponse {
        let current = try await fetchTariffTimeline(siteID: siteID)
        let costs = SystemCostsDTO(
            siteInstalled: current.systemCosts?.siteInstalled ?? DemoFixtures.siteInstalled,
            solar: body.solar,
            powerwall: body.powerwall
        )
        let next = SiteTariffsTimelineResponse(
            version: 2,
            siteId: current.siteId,
            timezone: current.timezone,
            currency: current.currency,
            periods: current.periods,
            referencePeriods: current.referencePeriods,
            battery: current.battery,
            reattribution: current.reattribution,
            holidayDates: current.holidayDates,
            teslaSync: current.teslaSync,
            systemCosts: costs
        )
        demoTimeline = next
        return next
    }

    func replacingReferencePeriods(
        in timeline: SiteTariffsTimelineResponse,
        with referencePeriods: [TariffPeriodDTO]
    ) -> SiteTariffsTimelineResponse {
        SiteTariffsTimelineResponse(
            version: 2,
            siteId: timeline.siteId,
            timezone: timeline.timezone,
            currency: timeline.currency,
            periods: timeline.periods,
            referencePeriods: referencePeriods,
            battery: timeline.battery,
            reattribution: timeline.reattribution,
            holidayDates: timeline.holidayDates,
            teslaSync: timeline.teslaSync,
            estimates: timeline.estimates,
            systemCosts: timeline.systemCosts,
            rateCountry: timeline.rateCountry
        )
    }

    func fetchSolarHistory(
        siteID: String, from: String, changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse {
        .enabled(
            timeZone: DemoFixtures.timeZone,
            days: DemoFixtures.solarHistoryDays(from: from, asOf: now()),
            nextFrom: nil
        )
    }

    func fetchBatteryHold(siteID: String) async throws -> BatteryHoldResponse {
        if let hold, now() >= hold.safetyExpiresAt { self.hold = nil }
        return BatteryHoldResponse(hold: hold, notice: nil)
    }

    func sendBatteryHoldCommand(siteID: String, command: BatteryHoldCommand) async throws -> BatteryHoldCommandResult {
        switch command {
        case .park(let choice):
            let date = now()
            let hours = choice.mode == .timer ? choice.durationHours : 8
            let started = BatteryHold(
                id: nextHoldID, siteID: siteID, status: .active, mode: choice.mode,
                originalReserve: 20, targetReserve: choice.reserveChoice ?? DemoFixtures.stateOfCharge,
                createdAt: date, safetyExpiresAt: date.addingTimeInterval(TimeInterval(hours) * 3600),
                cancelledObservedReserve: nil
            )
            nextHoldID += 1
            hold = started
            return BatteryHoldCommandResult(status: .succeeded, hold: started, current: nil)
        case .restore:
            hold = nil
        case .dismiss:
            break
        }
        return BatteryHoldCommandResult(status: .succeeded, hold: nil, current: nil)
    }

    func setBillingDay(siteID _: String, day: Int) async throws -> MobileBillingDay {
        guard MobileBillingDay.validDays.contains(day) else {
            throw PWUsageAPIError.requestRejected(statusCode: 400, message: "Billing day must be between 1 and 31")
        }
        billingDayOverride = day
        return MobileBillingDay(billingDay: day, billingDayConfirmed: true)
    }

    func exchangeSession(_ exchange: MobileSessionExchange) async throws -> MobileSessionCredential {
        MobileSessionCredential(cookies: [])
    }

    func store(_ credential: MobileSessionCredential) {}
    func logout() async throws {}
    func clearSiteAuthCookie() {}
}
