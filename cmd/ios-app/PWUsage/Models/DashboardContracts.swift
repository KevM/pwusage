import Foundation

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

enum SolarForecastEnhancementState: Equatable {
    case basic
    case loadingWithBasic
    case enhanced
    case failedWithBasic
    case disconnectedBasic
}

/// Whether the user has finished setting forecasting up on this device. Kept
/// apart from `SolarForecastEnhancementState` so the UI can stay silent when no
/// key exists and explain itself when one does.
enum SolarForecastConnectionState: Equatable {
    /// The device hasn't read its Solcast setup yet (at launch or after a site switch).
    case checking
    case notConnected
    case awaitingArraySelection
    case ready
}

/// Why forecast enhancement is unavailable, from the device's own request
/// bookkeeping. Kept apart from `SolarForecastRefreshFailure` so a spent daily
/// allowance is not reported as a failed request.
enum SolarForecastUnavailableCause: Equatable {
    case unauthorized
    case rateLimited
    case requestFailed
    case unknownResource
    case invalidForecast
    case storageFailure
    case cleanupFailure
    case budgetExhausted
    case deferred
}

/// Why the optional enhancement is not showing, when the connection itself is
/// healthy. Without this every failure collapsed into one sentence that named the
/// forecast, even when our own planning context was the missing piece.
enum SolarForecastUnavailableReason: Equatable {
    case contextUnavailable
    /// The server has history, but too few of the most recent days are complete
    /// to build a household profile.
    case insufficientHistory
    /// The server has history, but its timestamps never line up with the site's
    /// local five-minute grid, so no day can be counted.
    case timestampMisaligned
    /// The request itself was rejected, so nothing is known about the profile.
    case requestFailed
    /// This device's clock put the server's timestamp outside the age window, so
    /// the payload reads as stale or future-dated. Fixable on the device.
    case contextInvalid
    /// The server answered, but the payload failed contract validation for a reason
    /// no clock change can fix — wrong units, unknown timezone, bad history bounds.
    case contextMalformed
    /// The server does not have this route, so it predates the app build.
    case serverOutdated
    case forecastNotUsable
    case billUnavailable
    case siteMismatch
}

struct DashboardEndpointState<Response: Equatable>: Equatable {
    var response: Response?
    var lastSuccess: Date?
    var isRestored = false
    var isUnavailable = false
    /// Monotonic cadence for this endpoint. It lives with the endpoint so
    /// `reset()` clears both the data and the retry window together.
    var cadence = EndpointCadence()

    mutating func reset() {
        response = nil
        isRestored = false
        lastSuccess = nil
        isUnavailable = false
        cadence.reset()
    }
}

/// The sheet the dashboard itself owns. There is only one, but it stays a
/// value so an external launch can clear whatever is up in a single write.
/// Rate Plans and About are pages pushed from Settings, not sheets.
enum DashboardSheet: String, Identifiable, CaseIterable {
    case batteryHold

    var id: String { rawValue }
}
