import Foundation

/// Answers every request the demo makes from memory: no network, no account,
/// nothing stored. The battery hold is simulated so the one interactive action
/// behaves like the real one, and ends with the demo.
@MainActor
final class DemoAPI: PWUsageApplicationAPI, MobileBatteryHoldDataAPI, MobileTariffDataAPI {
    /// How long one source instant serves before the next fetch moves it up to
    /// the clock. Long enough that a refresh's fetches agree, short enough that
    /// a long session stays inside the balance freshness windows.
    static let sourceLifetime: TimeInterval = 10 * 60

    /// The demo data's source instant, shared by every fetch until it is
    /// `sourceLifetime` old. Two minutes back: minute timelines render with the
    /// minute's start, so a source inside it would read as in the future.
    private(set) var launchedAt: Date
    private let now: () -> Date
    private var hold: BatteryHold?
    private var nextHoldID = 1
    private var demoTimeline: SiteTariffsTimelineResponse?
    private var nextPeriodID = 100

    init(now: @escaping () -> Date = Date.init) {
        self.now = now
        launchedAt = Self.source(at: now())
    }

    private static func source(at date: Date) -> Date {
        Date(timeIntervalSince1970: floor(date.timeIntervalSince1970) - 120)
    }

    private func currentSource() -> Date {
        let date = now()
        if date.timeIntervalSince(launchedAt) > Self.sourceLifetime { launchedAt = Self.source(at: date) }
        return launchedAt
    }

    func fetchSites() async throws -> [MobileSite] { [DemoFixtures.site] }

    func fetchLive(siteID: String, refresh: Bool) async throws -> MobileLiveResponse {
        try DemoFixtures.live(asOf: currentSource())
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        try DemoFixtures.bill(asOf: currentSource())
    }

    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        DemoFixtures.planningContext(asOf: currentSource())
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
            teslaSync: current.teslaSync
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
                source: period.source,
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
            teslaSync: current.teslaSync
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
            teslaSync: current.teslaSync
        )
        demoTimeline = next
        return next
    }

    func retryTariffReattribution(siteID: String) async throws -> SiteTariffsTimelineResponse {
        try await fetchTariffTimeline(siteID: siteID)
    }

    func fetchSolarHistory(
        siteID: String, from: String, changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse {
        .enabled(timeZone: DemoFixtures.timeZone, days: [], nextFrom: nil)
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

    func setBillingDay(siteID: String, day: Int) async throws -> MobileBillingDay {
        throw PWUsageAPIError.requestRejected(statusCode: 403, message: "The demo is read-only")
    }

    /// The demo hides Trmnl settings, so nothing asks for devices.
    func fetchTrmnlDevices(siteID: String) async throws -> [TrmnlDevice] { [] }

    func fetchTrmnlPreview(siteID: String, screen: TrmnlComponentConfig?) async throws -> String {
        throw PWUsageAPIError.requestRejected(statusCode: 403, message: "The demo has no Trmnl")
    }

    func fetchTrmnlScreens(uuid: String) async throws -> [TrmnlManagedScreen] {
        throw PWUsageAPIError.requestRejected(statusCode: 403, message: "The demo has no Trmnl")
    }

    func saveTrmnlScreens(_ screens: [TrmnlManagedScreen], for device: TrmnlDevice, siteID: String) async throws {
        throw PWUsageAPIError.requestRejected(statusCode: 403, message: "The demo is read-only")
    }

    func exchangeSession(_ exchange: MobileSessionExchange) async throws {}
    func logout() async throws {}
    func clearSiteAuthCookie() async {}
}
