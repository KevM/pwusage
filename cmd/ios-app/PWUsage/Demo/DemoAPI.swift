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

    /// Activity markers need the current minute, not the data's source instant.
    func fetchTariffs(siteID: String) async throws -> MobileTariffsResponse {
        DemoFixtures.tariffs(asOf: now())
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

    func exchangeSession(_ exchange: MobileSessionExchange) async throws {}
    func logout() async throws {}
    func clearSiteAuthCookie() async {}
}
