import Foundation
@testable import PWUsage

/// Dashboard, planning and solar history API in one fake, all in UTC.
@MainActor
final class AutomaticForecastAPISpy: MobileDashboardDataAPI, MobileLoadPlanningDataAPI, MobileSolarHistoryDataAPI {
    let clock = MutableSolarClock(Date(timeIntervalSince1970: 1_800_000_000))
    var now: Date { clock.now() }
    var historyResponse: MobileSolarHistoryResponse = .enabled(timeZone: .gmt, days: [], nextFrom: nil)
    struct HistoryFetch: Equatable {
        let siteID: String
        let from: String
        let changedSince: Date?
    }

    var historyError: Error?
    var holdHistory = false
    private(set) var historyFetches: [HistoryFetch] = []
    private var historyContinuations: [CheckedContinuation<Void, Never>] = []

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

    func fetchSolarHistory(
        siteID: String, from: String, changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse {
        historyFetches.append(HistoryFetch(siteID: siteID, from: from, changedSince: changedSince))
        if holdHistory { await withCheckedContinuation { historyContinuations.append($0) } }
        if let historyError { throw historyError }
        return historyResponse
    }

    func resumeHistory() {
        holdHistory = false
        let pending = historyContinuations
        historyContinuations.removeAll()
        pending.forEach { $0.resume() }
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
    private var continuations: [CheckedContinuation<Void, Never>] = []
    var hold = false

    init(id: SolarForecastProviderID = .forecastSolar, now: @escaping @Sendable () -> Date) {
        descriptor = SolarForecastProviderDescriptor(
            id: id, displayName: "Forecast.Solar", attribution: "Forecast by Forecast.Solar.",
            requirement: .detectedLayout, providesCautiousPower: false,
            refreshThreshold: 3 * 3600, maximumUsableAge: 6 * 3600, modelVersion: "stub-1"
        )
        self.now = now
    }

    func setFailing(_ value: Bool) { failing = value }
    func setHold(_ value: Bool) { hold = value }

    func resume() {
        hold = false
        let pending = continuations
        continuations.removeAll()
        pending.forEach { $0.resume() }
    }

    func configuration(for request: SolarForecastRequest) async -> SolarForecastConfiguration {
        guard request.layout != nil, request.location != nil else {
            return SolarForecastConfiguration(readiness: .notConfigured, fingerprint: "", cacheRevision: "")
        }
        return SolarForecastConfiguration(readiness: .ready, fingerprint: "stub", cacheRevision: "stub")
    }

    func refresh(_ request: SolarForecastRequest) async -> SolarForecastProviderResult {
        refreshes += 1
        requests.append(request)
        if hold { await withCheckedContinuation { continuations.append($0) } }
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

@MainActor
final class AutomaticForecastHarness {
    let api = AutomaticForecastAPISpy()
    let solcast = FakeSolcastStore()
    let automatic: StubAutomaticProvider
    let history: SolarForecastHistory
    let service: SolarForecastService
    let records: SolarLayoutRecordStore
    let historyStore: SolarHistoryStore
    let runner: SolarLayoutDetectionRunner
    let coordinator: DashboardCoordinator

    nonisolated static let detectedLocation = SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device)
    nonisolated static let detectedLayout = SolarLayout(
        planes: [SolarLayoutPlane(azimuth: 180, tilt: 30, dcKwp: 5)], acClipKw: nil,
        confidence: .high, detectedAt: Date(timeIntervalSince1970: 1_800_000_000)
    )
    nonisolated static let detectedPlane = DetectedSolarLayout.Plane(
        azimuth: 180, tilt: 30, dcKwp: 5, effectiveKw: 4.25,
        azimuthRange90: [175, 185], tiltRange90: [25, 35]
    )
    nonisolated static let detectedResult = DetectedSolarLayout(
        status: .detected, confidence: "high", reasons: [],
        planes: [detectedPlane], acClipKw: nil,
        historyDays: 365, clearDays: 100, firstDay: "2025-01-01", lastDay: "2026-01-01"
    )
    nonisolated static let detectedResponse = MobileSolarLayoutResponse.enabled(
        location: detectedLocation, layout: detectedLayout, reason: nil
    )

    init(siteID: String = "site-a", correctsSolcast: Bool = false, seedDetected: Bool = true) async {
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
        let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(
            "harness-\(UUID().uuidString)", isDirectory: true
        )
        records = SolarLayoutRecordStore(directory: tempDir.appendingPathComponent("SolarLayout"))
        historyStore = SolarHistoryStore(directory: tempDir.appendingPathComponent("SolarHistory"))
        runner = SolarLayoutDetectionRunner(
            history: historyStore, records: records, api: api,
            detect: { _, _, _, _, _ in Self.detectedResult },
            now: { clock.now() }
        )
        coordinator = DashboardCoordinator(
            siteID: siteID, api: api, planningAPI: api, forecastStore: solcast, accountScopeID: "account-a",
            now: { clock.now() }, timerInterval: nil, forecastService: service,
            history: historyStore, records: records, runner: runner
        )
        if seedDetected {
            let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: siteID)
            let date = api.now
            try? await records.setLocation(Self.detectedLocation, scope: scope, at: date)
            try? await records.saveResult(Self.detectedResult, scope: scope, for: Self.detectedLocation, at: date)
        }
    }

    func seedDetected(siteID: String = "site-a") async throws {
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: siteID)
        let date = api.now
        try await records.setLocation(Self.detectedLocation, scope: scope, at: date)
        try await records.saveResult(Self.detectedResult, scope: scope, for: Self.detectedLocation, at: date)
    }

    func setPending(siteID: String = "site-a") async throws {
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: siteID)
        let date = api.now
        try await records.remove(scope: scope)
        try await records.setLocation(Self.detectedLocation, scope: scope, at: date)
    }

    func setNeedsLocation(siteID: String = "site-a") async throws {
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: siteID)
        try await records.remove(scope: scope)
    }

    func setLowConfidence(siteID: String = "site-a") async throws {
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: siteID)
        let date = api.now
        try await records.remove(scope: scope)
        try await records.setLocation(Self.detectedLocation, scope: scope, at: date)
        let lowConfResult = DetectedSolarLayout(
            status: .lowConfidence, confidence: "low", reasons: ["scatter"],
            planes: [], acClipKw: nil, historyDays: 365, clearDays: 20, firstDay: nil, lastDay: nil
        )
        try await records.saveResult(lowConfResult, scope: scope, for: Self.detectedLocation, at: date)
    }

    /// Fourteen days of raw history and actuals at `ratio` of the forecast for `identity`.
    func seedCorrection(ratio: Double, providerID: SolarForecastProviderID, fingerprint: String) async throws {
        let identity = SolarForecastHistoryIdentity(
            accountScopeID: "account-a", siteID: "site-a", providerID: providerID, fingerprint: fingerprint
        )
        let today = Date(timeIntervalSince1970: (api.now.timeIntervalSince1970 / 86400).rounded(.down) * 86400)
        var days: [MobileSolarHistoryDay] = []
        for back in 1 ... 14 {
            let day = today.addingTimeInterval(TimeInterval(-back) * 86400)
            let intervals = SolarProviderFixture.intervals(from: day, hours: 24, powerKw: 2)
            await history.record(identity: identity, intervals: intervals, fetchedAt: day.addingTimeInterval(-3600))
            await history.record(identity: identity, intervals: intervals, fetchedAt: day.addingTimeInterval(60))
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy-MM-dd"
            formatter.timeZone = .gmt
            let dayString = formatter.string(from: day)
            let slotWh = (2000.0 * ratio) / 12.0
            let slots = Array(repeating: slotWh, count: 288)
            days.append(MobileSolarHistoryDay(
                day: dayString, dayStart: day, status: .complete,
                fetchedAt: day.addingTimeInterval(3600), solarWh: slots
            ))
        }
        api.historyResponse = .enabled(timeZone: .gmt, days: days, nextFrom: nil)
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
        _ = try await historyStore.sync(scope: scope, api: api, now: api.now)
    }
}
