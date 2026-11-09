import AuthenticationServices
import Foundation
@testable import PWUsage
import Testing

@MainActor
final class AppTestClock {
    private(set) var now = Date(timeIntervalSince1970: 1_800_000_000)
    /// Wall time and the coordinator's monotonic cadence move together by
    /// default, the way they do on a running device.
    private(set) var monotonicNow = ContinuousClock().now

    func advance(minutes: Int) {
        now = now.addingTimeInterval(TimeInterval(minutes * 60))
        monotonicNow = monotonicNow.advanced(by: .seconds(minutes * 60))
    }
}

@MainActor
final class ApplicationAPISpy: PWUsageApplicationAPI, MobileBatteryHoldDataAPI {
    var batteryHoldResponse = BatteryHoldResponse(hold: nil, notice: nil)
    private(set) var holdCommands: [BatteryHoldCommand] = []
    func fetchBatteryHold(siteID: String) async throws -> BatteryHoldResponse { batteryHoldResponse }
    func sendBatteryHoldCommand(siteID: String, command: BatteryHoldCommand) async throws -> BatteryHoldCommandResult {
        holdCommands.append(command)
        return .init(status: .succeeded, hold: nil, current: nil)
    }
    private(set) var billingDayCalls: [(siteID: String, day: Int)] = []
    var billingDayError: Error?
    func setBillingDay(siteID: String, day: Int) async throws -> MobileBillingDay {
        billingDayCalls.append((siteID, day))
        if let billingDayError { throw billingDayError }
        return MobileBillingDay(billingDay: day, billingDayConfirmed: true)
    }
    var sites: [MobileSite]
    /// Consumed one entry per `fetchSites` before `sites` is used, so a test can
    /// hand successive attempts different site lists.
    var sitesSequence: [[MobileSite]] = []
    var sitesError: Error?
    var holdSites = false
    private var sitesContinuations: [CheckedContinuation<[MobileSite], Error>] = []
    var holdLive = false
    var holdLogout = false
    private(set) var logoutStarted = false
    private var logoutContinuation: CheckedContinuation<Void, Never>?
    private(set) var siteFetchCount = 0
    private(set) var liveSiteIDs: [String] = []
    private(set) var billSiteIDs: [String] = []
    private(set) var contextSiteIDs: [String] = []
    private(set) var cookieClearCount = 0
    private var liveContinuations: [(String, CheckedContinuation<MobileLiveResponse, Error>)] = []

    init(sites: [MobileSite], sitesError: Error? = nil, sitesSequence: [[MobileSite]] = []) {
        self.sites = sites
        self.sitesError = sitesError
        self.sitesSequence = sitesSequence
    }

    func fetchSites() async throws -> [MobileSite] {
        siteFetchCount += 1
        if holdSites { return try await withCheckedThrowingContinuation { sitesContinuations.append($0) } }
        if let sitesError { throw sitesError }
        if sitesSequence.isEmpty { return sites }
        return sitesSequence.removeFirst()
    }

    func resumeSites() {
        holdSites = false
        let pending = sitesContinuations
        sitesContinuations.removeAll()
        for continuation in pending {
            if let sitesError {
                continuation.resume(throwing: sitesError)
            } else {
                continuation.resume(returning: sites)
            }
        }
    }

    func fetchLive(siteID: String, refresh: Bool) async throws -> MobileLiveResponse {
        liveSiteIDs.append(siteID)
        if holdLive {
            return try await withCheckedThrowingContinuation { liveContinuations.append((siteID, $0)) }
        }
        return try Self.liveResponse(siteID: siteID)
    }

    func resumeLiveRequests() {
        holdLive = false
        let pending = liveContinuations
        liveContinuations.removeAll()
        for (siteID, continuation) in pending {
            do {
                continuation.resume(returning: try Self.liveResponse(siteID: siteID))
            } catch {
                // A broken fixture fails the one test awaiting this continuation,
                // with the decode error attached, instead of trapping the binary.
                continuation.resume(throwing: error)
            }
        }
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        billSiteIDs.append(siteID)
        return try Self.billResponse(siteID: siteID)
    }

    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        contextSiteIDs.append(siteID)
        throw PWUsageAPIError.invalidResponse
    }

    var exchangeError: Error?
    func exchangeSession(_ exchange: MobileSessionExchange) async throws {
        if let exchangeError { throw exchangeError }
    }
    func logout() async throws {
        logoutStarted = true
        if holdLogout {
            await withCheckedContinuation { logoutContinuation = $0 }
        }
    }
    func resumeLogout() {
        holdLogout = false
        logoutContinuation?.resume()
        logoutContinuation = nil
    }
    func clearSiteAuthCookie() async { cookieClearCount += 1 }

    private static func liveResponse(siteID: String) throws -> MobileLiveResponse {
        // A charge reading older than two hours decodes as unknown, so date it now rather than
        // reusing the deliberately stale `liveStatusAt` above.
        let chargeAt = ISO8601DateFormatter().string(from: Date())
        let json = #"""
        {"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC","localDate":"2026-09-23"},
         "live":{"solarPower":100,"loadPower":200,"batteryPower":0,"gridPower":100},"stateOfCharge":50,
         "activeTariff":"Peak","today":{"homeKwh":1,"solarKwh":2,"gridNetKwh":3,"batteryNetKwh":4},
         "todayComplete":true,"currentBill":null,
         "sources":{"liveStatusAt":"2026-09-23T12:00:00Z","energyDataThrough":"2026-09-23T12:00:00Z",
         "stateOfChargeAt":"\#(chargeAt)"}}
        """#
        return try MobileContractDecoder.make().decode(MobileLiveResponse.self, from: Data(json.utf8))
    }

    private static func billResponse(siteID: String) throws -> MobileBillResponse {
        let json = #"""
        {"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC"},
         "currentBill":{"estimatedCost":42,"currency":"USD","cycleStart":"2026-09-01T00:00:00Z",
         "cycleEnd":"2026-10-01T00:00:00Z","periods":[]},
         "sources":{"calculatedAt":"2026-09-23T12:00:00Z","energyDataThrough":null}}
        """#
        return try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(json.utf8))
    }
}

actor ForecastServiceSpy: SolarForecastServing {
    private var holdActivation = false
    private var activationParked = false
    private var parkedActivation: CheckedContinuation<Void, Never>?

    func setHoldActivation(_ value: Bool) { holdActivation = value }
    var activationIsParked: Bool { activationParked }
    func resumeActivation() { parkedActivation?.resume(); parkedActivation = nil }

    func activateAccountScope(_ accountScopeID: String?) async {
        if holdActivation {
            holdActivation = false
            activationParked = true
            await withCheckedContinuation { parkedActivation = $0 }
            activationParked = false
        }
    }
    nonisolated var automaticDescriptor: SolarForecastProviderDescriptor? { nil }
    nonisolated func descriptor(for id: SolarForecastProviderID) -> SolarForecastProviderDescriptor? { nil }
    private(set) var refreshCount = 0
    func publicationAttempt(
        for request: SolarForecastRequest, actuals: [MobileSolarActualsHour]?
    ) async -> SolarForecastPublicationAttempt {
        refreshCount += 1
        return SolarForecastPublicationAttempt(
            publication: nil, providerID: nil, outcome: .unavailable, diagnostic: nil
        )
    }
    func clearAccountData() async throws {}
}

@MainActor
final class AppAuthWebSession: MobileAuthWebSession {
    var prefersEphemeralWebBrowserSession = false
    var presentationContextProvider: (any ASWebAuthenticationPresentationContextProviding)?
    var loginURL: URL?
    var completion: MobileAuthService.SessionCompletion?
    func start() -> Bool { true }
    func cancel() {}
}
