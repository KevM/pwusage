import Foundation

/// Open-Meteo for the server-detected layout. Owns transport, conversion and the
/// device-wide request ledger; caching is the shared automatic-provider cache.
actor OpenMeteoProvider: SolarForecastProviding {
    nonisolated let descriptor = SolarForecastProviderDescriptor(
        id: .openMeteo,
        displayName: "Open-Meteo",
        attribution: "Forecast by Open-Meteo.",
        requirement: .detectedLayout,
        providesCautiousPower: false,
        refreshThreshold: SolarForecastStore.foregroundRefreshThreshold,
        maximumUsableAge: SolarForecastStore.recommendationFreshness,
        modelVersion: "open-meteo-haydavies-1"
    )

    static let requestLedger = ForecastSolarRequestLedger(
        file: ProtectedSolarForecastFile(name: "open-meteo-ledger.json", backgroundAccessible: true)
    )

    private let client: OpenMeteoClient
    private let ledger: ForecastSolarRequestLedger
    private let cache: SolarForecastAutomaticCache
    private let clock: any SolarForecastClock
    private var accountScopeID: String?
    private var generation = 0
    private var revisions: [SolarForecastSiteScope: String] = [:]
    private struct Fetch { let id: UUID; let task: Task<SolarForecastProviderResult, Never> }
    private var inFlight: [String: Fetch] = [:]

    init(
        client: OpenMeteoClient = OpenMeteoClient(),
        ledger: ForecastSolarRequestLedger = OpenMeteoProvider.requestLedger,
        cache: SolarForecastAutomaticCache = .shared,
        clock: any SolarForecastClock = SystemSolarForecastClock()
    ) {
        self.client = client
        self.ledger = ledger
        self.cache = cache
        self.clock = clock
    }

    func configuration(for request: SolarForecastRequest) async -> SolarForecastConfiguration {
        guard let location = request.location, location.isValid, let layout = request.layout,
              (1 ... 3).contains(layout.planes.count), layout.planes.allSatisfy(\.isValid) else {
            return SolarForecastConfiguration(readiness: .notConfigured, fingerprint: "", cacheRevision: "")
        }
        // Use the actual geometry, not the integer angles needed by Forecast.Solar.
        let planes = layout.planes.map { plane in
            [plane.azimuth, plane.tilt, plane.dcKwp].map { String($0) }.joined(separator: ",")
        }.sorted()
        let fingerprint = SolarForecastConfiguration.fingerprint([
            descriptor.id.rawValue, descriptor.modelVersion,
            String(location.latitude), String(location.longitude),
            planes.joined(separator: ";"), layout.acClipKw.map { String($0) } ?? "none",
            request.siteTimeZone.identifier])
        let detected = layout.detectedAt.map { String($0.timeIntervalSince1970) } ?? "none"
        return SolarForecastConfiguration(
            readiness: .ready, fingerprint: fingerprint, cacheRevision: "\(fingerprint)@\(detected)"
        )
    }

    func refresh(_ request: SolarForecastRequest) async -> SolarForecastProviderResult {
        let startedGeneration = generation
        let configuration = await configuration(for: request)
        guard startedGeneration == generation, !Task.isCancelled else { return Self.cancelled }
        revisions[request.scope] = configuration.cacheRevision
        guard configuration.readiness == .ready, let location = request.location, let layout = request.layout else {
            return SolarForecastProviderResult(batch: nil, outcome: .setupRequired)
        }
        let cached = await cache.batch(
            scope: request.scope, providerID: descriptor.id, cacheRevision: configuration.cacheRevision
        )
        guard startedGeneration == generation, revisions[request.scope] == configuration.cacheRevision,
              !Task.isCancelled else { return Self.cancelled }
        // Fresh is not enough: after site-local midnight a recent batch can end a day too early.
        if !request.manual, let cached,
           (0 ..< descriptor.refreshThreshold).contains(clock.now().timeIntervalSince(cached.fetchedAt)),
           cached.coverage.start <= request.window.start, cached.coverage.end >= request.window.end {
            return SolarForecastProviderResult(batch: cached, outcome: .fresh)
        }
        let scopeKey = SolarForecastScope.key(request.scope.accountScopeID, request.scope.siteID)
        let key = "\(scopeKey)#\(configuration.cacheRevision)"
        if let existing = inFlight[key] {
            let result = await withTaskCancellationHandler {
                await existing.task.value
            } onCancel: { existing.task.cancel() }
            return Task.isCancelled ? Self.cancelled : result
        }
        let fetchGeneration = generation
        let id = UUID()
        let task = Task {
            await self.fetch(
                request,
                location: location,
                layout: layout,
                configuration: configuration,
                generation: fetchGeneration
            )
        }
        inFlight[key] = Fetch(id: id, task: task)
        let result = await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
        if inFlight[key]?.id == id { inFlight[key] = nil }
        guard fetchGeneration == generation, revisions[request.scope] == configuration.cacheRevision,
              !Task.isCancelled else { return Self.cancelled }
        return result
    }

    func cachedForecast(for request: SolarForecastRequest) async -> SolarForecastRawBatch? {
        let configuration = await configuration(for: request)
        guard configuration.readiness == .ready else { return nil }
        return await cache.batch(
            scope: request.scope,
            providerID: descriptor.id,
            cacheRevision: configuration.cacheRevision
        )
    }

    func activateAccountScope(_ accountScopeID: String?) async {
        guard accountScopeID != self.accountScopeID else { return }
        self.accountScopeID = accountScopeID
        generation += 1
        for task in inFlight.values { task.task.cancel() }
        inFlight.removeAll()
        revisions.removeAll()
    }

    /// Clears cached forecasts. The request ledger is device-wide and deliberately kept.
    func clearAccountData() async throws {
        generation += 1
        for task in inFlight.values { task.task.cancel() }
        inFlight.removeAll()
        revisions.removeAll()
        try await cache.clearAccountData()
    }

    private func fetch(
        _ request: SolarForecastRequest,
        location: SolarHomeLocation,
        layout: SolarLayout,
        configuration: SolarForecastConfiguration,
        generation fetchGeneration: Int
    ) async -> SolarForecastProviderResult {
        if let refused = Self.refusal(await ledger.reserve(1)) { return refused }
        return await send(request, location: location, layout: layout, configuration: configuration,
                          generation: fetchGeneration)
    }

    private static let cancelled = SolarForecastProviderResult(batch: nil, outcome: .cancelled)

    private static func refusal(_ reservation: ForecastSolarReservation) -> SolarForecastProviderResult? {
        switch reservation {
        case .granted: return nil
        case .deferred(let until): return SolarForecastProviderResult(batch: nil, outcome: .deferred(until: until))
        case .exhausted: return SolarForecastProviderResult(batch: nil, outcome: .budgetExhausted)
        case .storageFailed:
            return SolarForecastProviderResult(
                batch: nil, outcome: .failed(.transient), diagnostic: "Forecast request budget could not be saved"
            )
        }
    }

    private func send(
        _ request: SolarForecastRequest,
        location: SolarHomeLocation,
        layout: SolarLayout,
        configuration: SolarForecastConfiguration,
        generation fetchGeneration: Int
    ) async -> SolarForecastProviderResult {
        do {
            try Task.checkCancellation()
            let weather = try await client.forecast(location: location)
            let intervals = try weather.intervals(layout: layout, location: location, window: request.window)
            try Task.checkCancellation()
            let now = clock.now()
            guard fetchGeneration == generation, revisions[request.scope] == configuration.cacheRevision else {
                return Self.cancelled
            }
            let batch = SolarForecastRawBatch(
                providerID: descriptor.id, fingerprint: configuration.fingerprint,
                cacheRevision: configuration.cacheRevision, intervals: intervals, fetchedAt: now,
                acClipKw: layout.acClipKw
            )
            await cache.store(batch, scope: request.scope)
            return SolarForecastProviderResult(batch: batch, outcome: .refreshed)
        } catch is CancellationError {
            return Self.cancelled
        } catch let error as OpenMeteoClientError {
            if case .rateLimited(let until) = error {
                let deadline = until ?? clock.now().addingTimeInterval(OpenMeteoClient.defaultDeferral)
                await ledger.recordDeferral(until: deadline)
                return SolarForecastProviderResult(batch: nil, outcome: .deferred(until: deadline))
            }
            guard fetchGeneration == generation, revisions[request.scope] == configuration.cacheRevision else {
                return Self.cancelled
            }
            return SolarForecastProviderResult(
                batch: nil, outcome: .failed(Self.category(error)), diagnostic: "Open-Meteo request failed"
            )
        } catch {
            return SolarForecastProviderResult(
                batch: nil, outcome: .failed(.invalidResponse), diagnostic: "Open-Meteo response was unusable"
            )
        }
    }

    private static func category(_ error: OpenMeteoClientError) -> SolarForecastFailureCategory {
        switch error {
        case .transportFailure, .rateLimited: .transient
        case .invalidResponse, .decodingFailure: .invalidResponse
        case .httpStatus(let status) where status == 401 || status == 403: .access
        case .httpStatus(let status) where status >= 500: .transient
        case .httpStatus: .configuration
        }
    }
}
