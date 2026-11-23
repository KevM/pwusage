import Foundation
import PWUsageCore

@MainActor
protocol MobileDashboardDataAPI: Sendable {
    /// `refresh` asks the server to import today's history before answering.
    func fetchLive(siteID: String, refresh: Bool) async throws -> MobileLiveResponse
    func fetchBill(siteID: String) async throws -> MobileBillResponse
}

extension MobileDashboardDataAPI {
    func fetchLive(siteID: String) async throws -> MobileLiveResponse {
        try await fetchLive(siteID: siteID, refresh: false)
    }
}

/// A response can be reused only when the server confirms its revision.
@MainActor
protocol MobileConditionalDashboardDataAPI: Sendable {
    func fetchLive(
        siteID: String, refresh: Bool, historyCheck: Bool, reusing cached: MobileLiveResponse?
    ) async throws -> MobileLiveResponse
    func fetchBill(siteID: String, reusing cached: MobileBillResponse?) async throws -> MobileBillResponse
}

/// Optional capability so older servers/preview fixtures retain the combined path.
@MainActor
protocol MobileLivePowerDataAPI: Sendable {
    func fetchLivePower(siteID: String) async throws -> MobileLivePowerResponse
}

@MainActor
protocol MobileLoadPlanningDataAPI: Sendable {
    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse
}

@MainActor
protocol MobileBatteryHoldDataAPI: Sendable {
    func fetchBatteryHold(siteID: String) async throws -> BatteryHoldResponse
    func sendBatteryHoldCommand(siteID: String, command: BatteryHoldCommand) async throws -> BatteryHoldCommandResult
}

protocol MobileBillShadowAPI: Sendable {
    func reportBillShadow(_ report: BillShadowReport) async throws
}

/// Home is waiting for a fresh reading from one endpoint: the one it holds, if any,
/// was too old to show on arrival. Cleared by a success.
struct FreshReadingWait: Equatable {
    let since: Date
    var hasFailed = false
}

struct DashboardEndpointState<Response: Equatable>: Equatable {
    var response: Response?
    var lastSuccess: Date?
    var isRestored = false
    var isUnavailable = false
    /// Set on arrival when `response` is missing or too old for Home to show.
    var freshReadingWait: FreshReadingWait?
    /// Monotonic cadence for this endpoint. It lives with the endpoint so
    /// `reset()` clears both the data and the retry window together.
    var cadence = EndpointCadence()

    mutating func reset() {
        response = nil
        isRestored = false
        lastSuccess = nil
        isUnavailable = false
        freshReadingWait = nil
        cadence.reset()
    }
}

/// The sheets the dashboard itself owns. Only one is up at a time, and it stays a
/// value so an external launch can clear whatever is up in a single write.
/// Rate Plans and About are pages pushed from Settings, not sheets; the estimate
/// setup pickers are the sheets added for estimated rate plans.
enum DashboardSheet: String, Identifiable, CaseIterable {
    case batteryHold
    /// Estimate setup: the site's country, the utility, or the rate plan on the chosen utility.
    case confirmCountry
    case chooseUtility
    case choosePlan
    /// The rate plan history guide, from the Home accessory.
    case rateHistory

    var id: String { rawValue }
}
