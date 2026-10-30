import Foundation
@testable import PWUsage

/// Dashboard, planning and solar-layout API in one fake, all in UTC.
@MainActor
final class AutomaticForecastAPISpy: MobileDashboardDataAPI, MobileLoadPlanningDataAPI, MobileSolarLayoutDataAPI {
    static let detected = MobileSolarLayoutResponse.enabled(
        location: SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device),
        layout: SolarLayout(
            planes: [SolarLayoutPlane(azimuth: 180, tilt: 30, dcKwp: 5)], acClipKw: nil,
            confidence: .high, detectedAt: Date(timeIntervalSince1970: 1_790_000_000)
        ),
        reason: nil
    )

    let clock = MutableSolarClock(Date(timeIntervalSince1970: 1_800_000_000))
    var now: Date { clock.now() }
    var layout: MobileSolarLayoutResponse = detected
    var layoutError: Error?
    var actuals: MobileSolarActualsResponse = .disabled
    var actualsError: Error?
    var holdLayout = false
    private(set) var layoutSiteIDs: [String] = []
    private(set) var actualsSiteIDs: [String] = []
    struct PostedLocation: Equatable {
        let siteID: String
        let latitude: Double
        let longitude: Double
    }

    private(set) var postedLocations: [PostedLocation] = []
    var postError: Error?
    private var layoutContinuations: [CheckedContinuation<Void, Never>] = []

    func fetchLive(siteID: String) async throws -> MobileLiveResponse { throw PWUsageAPIError.invalidResponse }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        let json = #"{"version":1,"site":{"id":"\#(siteID)","name":"Home","timezone":"UTC"},"#
            + #""currentBill":{"estimatedCost":1,"currency":"USD","cycleStart":"2026-01-01T00:00:00Z","#
            + #""cycleEnd":"2030-01-01T00:00:00Z","periods":[]},"#
            + #""sources":{"calculatedAt":"2027-01-15T08:00:00Z","energyDataThrough":"2027-01-15T07:55:00Z"}}"#
        return try MobileContractDecoder.make().decode(MobileBillResponse.self, from: Data(json.utf8))
    }

    func fetchLoadPlanningContext(siteID: String) async throws -> MobileLoadPlanningContextResponse {
        MobileLoadPlanningContextResponse(
            version: 1,
            site: .init(id: siteID, timezone: "UTC"),
            units: .init(power: "kW", localMinute: "minute-of-day"),
            asOf: now, availability: .available, unavailableReason: nil, usableDayCount: 14,
            historyStart: now.addingTimeInterval(-14 * 86400), historyEnd: now.addingTimeInterval(-60),
            slots: (0 ..< 48).map {
                .init(localMinute: $0 * 30, homeKw: 1, batteryNetChargeKw: 0, sampleCount: 14, coverage: 1)
            }
        )
    }

    func fetchSolarLayout(siteID: String) async throws -> MobileSolarLayoutResponse {
        layoutSiteIDs.append(siteID)
        if holdLayout { await withCheckedContinuation { layoutContinuations.append($0) } }
        if let layoutError { throw layoutError }
        return layout
    }

    func resumeLayout() {
        holdLayout = false
        let pending = layoutContinuations
        layoutContinuations.removeAll()
        pending.forEach { $0.resume() }
    }

    func postSolarLocation(siteID: String, latitude: Double, longitude: Double) async throws {
        if let postError { throw postError }
        postedLocations.append(PostedLocation(siteID: siteID, latitude: latitude, longitude: longitude))
    }

    func fetchSolarActuals(siteID: String) async throws -> MobileSolarActualsResponse {
        actualsSiteIDs.append(siteID)
        if let actualsError { throw actualsError }
        return actuals
    }
}

/// An automatic provider with Forecast.Solar's identity that returns 2 kW for every hour
/// from local midnight to the end of the request window.
actor StubAutomaticProvider: SolarForecastProviding {
    nonisolated let descriptor: SolarForecastProviderDescriptor
    private let now: @Sendable () -> Date
    private var cache: [SolarForecastSiteScope: SolarForecastRawBatch] = [:]
    private(set) var refreshes = 0
    private(set) var requests: [SolarForecastRequest] = []
    var failing = false

    init(id: SolarForecastProviderID = .forecastSolar, now: @escaping @Sendable () -> Date) {
        descriptor = SolarForecastProviderDescriptor(
            id: id, displayName: "Forecast.Solar", attribution: "Forecast by Forecast.Solar.",
            requirement: .detectedLayout, providesCautiousPower: false,
            refreshThreshold: 3 * 3600, maximumUsableAge: 6 * 3600, modelVersion: "stub-1"
        )
        self.now = now
    }

    func setFailing(_ value: Bool) { failing = value }

    func configuration(for request: SolarForecastRequest) async -> SolarForecastConfiguration {
        guard request.layout != nil, request.location != nil else {
            return SolarForecastConfiguration(readiness: .notConfigured, fingerprint: "", cacheRevision: "")
        }
        return SolarForecastConfiguration(readiness: .ready, fingerprint: "stub", cacheRevision: "stub")
    }

    func refresh(_ request: SolarForecastRequest) async -> SolarForecastProviderResult {
        refreshes += 1
        requests.append(request)
        if failing { return SolarForecastProviderResult(batch: nil, outcome: .failed(.transient)) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = request.siteTimeZone
        let start = calendar.startOfDay(for: request.window.start)
        let hours = Int(request.window.end.timeIntervalSince(start) / 3600)
        let batch = SolarForecastRawBatch(
            providerID: descriptor.id, fingerprint: "stub", cacheRevision: "stub",
            intervals: SolarProviderFixture.intervals(from: start, hours: hours, powerKw: 2),
            fetchedAt: now(), acClipKw: nil
        )
        cache[request.scope] = batch
        return SolarForecastProviderResult(batch: batch, outcome: .refreshed)
    }

    func cachedForecast(for request: SolarForecastRequest) async -> SolarForecastRawBatch? { cache[request.scope] }
    func activateAccountScope(_ accountScopeID: String?) async {}
    func clearAccountData() async throws { cache.removeAll() }
}

/// Records scheduled revalidations so a test can fire them without waiting.
@MainActor
final class ManualRevalidationScheduler: SolarLayoutRevalidationScheduling {
    struct Scheduled {
        let delay: TimeInterval
        let handle: SolarLayoutRevalidationHandle
        let work: @MainActor () async -> Void
    }

    private(set) var scheduled: [Scheduled] = []
    var pending: [Scheduled] { scheduled.filter { !$0.handle.isCancelled } }

    func schedule(
        after delay: TimeInterval,
        _ work: @escaping @MainActor () async -> Void
    ) -> SolarLayoutRevalidationHandle {
        let handle = SolarLayoutRevalidationHandle()
        scheduled.append(Scheduled(delay: delay, handle: handle, work: work))
        return handle
    }

    /// Runs every pending revalidation once.
    func fire() async {
        let due = pending
        scheduled.removeAll()
        for item in due { await item.work() }
    }
}

@MainActor
struct AutomaticForecastHarness {
    let api = AutomaticForecastAPISpy()
    let solcast = FakeSolcastStore()
    let automatic: StubAutomaticProvider
    let history: SolarForecastHistory
    let service: SolarForecastService
    let scheduler = ManualRevalidationScheduler()
    let coordinator: DashboardCoordinator

    init(siteID: String = "site-a", correctsSolcast: Bool = false) {
        let api = api
        let clock = api.clock
        automatic = StubAutomaticProvider { clock.now() }
        history = SolarForecastHistory(file: InMemorySolarFile(), clock: clock)
        service = SolarForecastService(
            providers: [SolcastForecastProvider(store: solcast), automatic],
            policy: SolarForecastSelectionPolicy(
                automaticProviderID: .forecastSolar,
                correctsCredentialProviders: correctsSolcast
            ),
            history: history, clock: clock
        )
        coordinator = DashboardCoordinator(
            siteID: siteID, api: api, planningAPI: api, forecastStore: solcast, accountScopeID: "account-a",
            now: { api.now }, timerInterval: nil, layoutAPI: api, forecastService: service,
            revalidationScheduler: scheduler
        )
    }

    /// Fourteen days of raw history and actuals at `ratio` of the forecast for `identity`,
    /// fetched the day before each target (day-ahead) and early on each target day (same-day).
    func seedCorrection(ratio: Double, providerID: SolarForecastProviderID, fingerprint: String) async {
        let identity = SolarForecastHistoryIdentity(
            accountScopeID: "account-a", siteID: "site-a", providerID: providerID, fingerprint: fingerprint
        )
        var hours: [MobileSolarActualsHour] = []
        let today = Date(timeIntervalSince1970: (api.now.timeIntervalSince1970 / 86400).rounded(.down) * 86400)
        for back in 1 ... 14 {
            let day = today.addingTimeInterval(TimeInterval(-back) * 86400)
            let intervals = SolarProviderFixture.intervals(from: day, hours: 24, powerKw: 2)
            await history.record(identity: identity, intervals: intervals, fetchedAt: day.addingTimeInterval(-3600))
            await history.record(identity: identity, intervals: intervals, fetchedAt: day.addingTimeInterval(60))
            hours += (0 ..< 24).map {
                MobileSolarActualsHour(
                    hourStart: day.addingTimeInterval(TimeInterval($0) * 3600), energyWh: 2000 * ratio, complete: true
                )
            }
        }
        api.actuals = .enabled(asOf: api.now, hours: hours)
    }
}
