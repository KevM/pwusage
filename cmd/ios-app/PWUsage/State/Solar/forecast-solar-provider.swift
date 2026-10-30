import Foundation

/// Forecast.Solar for the server-detected layout. Owns transport, conversion and the
/// device-wide request ledger; caching is the shared automatic-provider cache.
actor ForecastSolarProvider: SolarForecastProviding {
    nonisolated let descriptor = SolarForecastProviderDescriptor(
        id: .forecastSolar,
        displayName: "Forecast.Solar",
        attribution: "Forecast by Forecast.Solar.",
        requirement: .detectedLayout,
        providesCautiousPower: false,
        refreshThreshold: SolarForecastStore.foregroundRefreshThreshold,
        maximumUsableAge: SolarForecastStore.recommendationFreshness,
        modelVersion: "forecast-solar-1"
    )

    private let client: ForecastSolarClient
    private let ledger: ForecastSolarRequestLedger
    private let cache: SolarForecastAutomaticCache
    private let clock: any SolarForecastClock
    private var accountScopeID: String?
    private var generation = 0
    private var inFlight: [String: Task<SolarForecastProviderResult, Never>] = [:]

    init(
        client: ForecastSolarClient = ForecastSolarClient(),
        ledger: ForecastSolarRequestLedger = .shared,
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
        // The values the request actually sends, so equivalent layouts share history.
        let planes = layout.planes.map { plane in
            [
                String(ForecastSolarForecast.forecastSolarAzimuth(compass: plane.azimuth)),
                String(Int(plane.tilt.rounded())),
                String(format: "%.2f", plane.dcKwp)].joined(separator: ",")
        }.sorted()
        let fingerprint = SolarForecastConfiguration.fingerprint([
            descriptor.id.rawValue, descriptor.modelVersion,
            String(format: "%.2f,%.2f", location.latitude, location.longitude),
            planes.joined(separator: ";"), layout.acClipKw.map { String(format: "%.3f", $0) } ?? "none",
            request.siteTimeZone.identifier])
        let detected = layout.detectedAt.map { String($0.timeIntervalSince1970) } ?? "none"
        return SolarForecastConfiguration(
            readiness: .ready, fingerprint: fingerprint, cacheRevision: "\(fingerprint)@\(detected)"
        )
    }

    func refresh(_ request: SolarForecastRequest) async -> SolarForecastProviderResult {
        let configuration = await configuration(for: request)
        guard configuration.readiness == .ready, let location = request.location, let layout = request.layout else {
            return SolarForecastProviderResult(batch: nil, outcome: .setupRequired)
        }
        let cached = await cache.batch(
            scope: request.scope, providerID: descriptor.id, cacheRevision: configuration.cacheRevision
        )
        // Fresh is not enough: after site-local midnight a recent batch can end a day too early.
        if !request.manual, let cached,
           (0 ..< descriptor.refreshThreshold).contains(clock.now().timeIntervalSince(cached.fetchedAt)),
           cached.coverage.start <= request.window.start, cached.coverage.end >= request.window.end {
            return SolarForecastProviderResult(batch: cached, outcome: .fresh)
        }
        let scopeKey = SolarForecastScope.key(request.scope.accountScopeID, request.scope.siteID)
        let key = "\(scopeKey)#\(configuration.cacheRevision)"
        if let existing = inFlight[key] { return await existing.value }
        let fetchGeneration = generation
        let task = Task {
            await self.fetch(
                request,
                location: location,
                layout: layout,
                configuration: configuration,
                generation: fetchGeneration
            )
        }
        inFlight[key] = task
        let result = await task.value
        inFlight[key] = nil
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
    }

    /// Clears cached forecasts. The request ledger is device-wide and deliberately kept.
    func clearAccountData() async throws {
        generation += 1
        try await cache.clearAccountData()
    }

    private func fetch(
        _ request: SolarForecastRequest,
        location: SolarHomeLocation,
        layout: SolarLayout,
        configuration: SolarForecastConfiguration,
        generation fetchGeneration: Int
    ) async -> SolarForecastProviderResult {
        if let refused = Self.refusal(await ledger.reserve(layout.planes.count)) { return refused }
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
            var estimates: [ForecastSolarPlaneEstimate] = []
            for plane in layout.planes {
                estimates.append(try await client.estimate(location: location, plane: plane))
            }
            let now = clock.now()
            let intervals = try ForecastSolarForecast.intervals(
                estimates: estimates, acClipKw: layout.acClipKw, siteTimeZone: request.siteTimeZone, now: now
            )
            guard fetchGeneration == generation else { return Self.cancelled }
            let batch = SolarForecastRawBatch(
                providerID: descriptor.id, fingerprint: configuration.fingerprint,
                cacheRevision: configuration.cacheRevision, intervals: intervals, fetchedAt: now,
                acClipKw: layout.acClipKw
            )
            await cache.store(batch, scope: request.scope)
            return SolarForecastProviderResult(batch: batch, outcome: .refreshed)
        } catch is CancellationError {
            return Self.cancelled
        } catch let error as ForecastSolarClientError {
            if case .rateLimited(let until) = error {
                let deadline = until ?? clock.now().addingTimeInterval(ForecastSolarClient.defaultDeferral)
                await ledger.recordDeferral(until: deadline)
                return SolarForecastProviderResult(batch: nil, outcome: .deferred(until: deadline))
            }
            guard fetchGeneration == generation else { return Self.cancelled }
            return SolarForecastProviderResult(
                batch: nil, outcome: .failed(Self.category(error)), diagnostic: "Forecast.Solar request failed"
            )
        } catch {
            return SolarForecastProviderResult(
                batch: nil, outcome: .failed(.invalidResponse), diagnostic: "Forecast.Solar response was unusable"
            )
        }
    }

    private static func category(_ error: ForecastSolarClientError) -> SolarForecastFailureCategory {
        switch error {
        case .transportFailure, .rateLimited: .transient
        case .invalidResponse, .decodingFailure: .invalidResponse
        case .httpStatus(let status) where status == 401 || status == 403: .access
        case .httpStatus(let status) where status >= 500: .transient
        case .httpStatus: .configuration
        }
    }
}
