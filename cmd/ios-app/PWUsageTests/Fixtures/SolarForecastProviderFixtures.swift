import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

enum SolarProviderFixture {
    static let chicago = TimeZone(identifier: "America/Chicago") ?? .gmt
    static let scopeA = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
    static let scopeB = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-b")
    static let location = SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device)
    static let detectedAt = Date(timeIntervalSince1970: 1_790_000_000)

    static func layout(
        planes: [SolarLayoutPlane] = [SolarLayoutPlane(azimuth: 90, tilt: 18, dcKwp: 5.6)],
        detectedAt: Date? = detectedAt
    ) -> SolarLayout {
        SolarLayout(planes: planes, acClipKw: nil, confidence: .high, detectedAt: detectedAt)
    }

    static func date(_ text: String, in zone: TimeZone = chicago) -> Date {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter.date(from: text) ?? .distantPast
    }

    static func request(
        scope: SolarForecastSiteScope = scopeA,
        now: Date,
        manual: Bool = false,
        layout: SolarLayout? = layout(),
        location: SolarHomeLocation? = location
    ) -> SolarForecastRequest {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = chicago
        let end = calendar.date(byAdding: .day, value: 2, to: calendar.startOfDay(for: now)) ?? now
        return SolarForecastRequest(
            scope: scope, siteTimeZone: chicago, window: DateInterval(start: now, end: end),
            manual: manual, layout: layout, location: location
        )
    }

    /// Hourly intervals of `powerKw` from `start` for `hours` hours.
    static func intervals(
        from start: Date,
        hours: Int,
        powerKw: Double,
        step: TimeInterval = 3600
    ) -> [SolarForecastInterval] {
        let count = Int(Double(hours) * 3600 / step)
        return (0 ..< count).map { index in
            let periodStart = start.addingTimeInterval(TimeInterval(index) * step)
            return SolarForecastInterval(
                periodStart: periodStart,
                periodEnd: periodStart.addingTimeInterval(step),
                powerKw: powerKw
            )
        }
    }

    /// An Open-Meteo body covering three days from UTC midnight of `now`.
    static func openMeteoBody(now: Date) -> Data {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        return (try? OpenMeteoFixture.body(start: utc.startOfDay(for: now))) ?? Data()
    }
}

/// An Open-Meteo adapter over in-memory files and a recording transport.
struct OpenMeteoHarness {
    let clock: MutableSolarClock
    let transport: OpenMeteoTestTransport
    let ledgerFile: InMemorySolarFile<SolarForecastRequestLedgerState>
    let cacheFile: InMemorySolarFile<SolarForecastAutomaticCacheState>
    let provider: OpenMeteoProvider

    init(
        clock: MutableSolarClock,
        body: Data,
        status: Int = 200,
        ledgerFile: InMemorySolarFile<SolarForecastRequestLedgerState> = InMemorySolarFile(),
        cacheFile: InMemorySolarFile<SolarForecastAutomaticCacheState> = InMemorySolarFile()
    ) {
        self.clock = clock
        transport = OpenMeteoTestTransport(body: body, status: status)
        self.ledgerFile = ledgerFile
        self.cacheFile = cacheFile
        provider = OpenMeteoProvider(
            client: OpenMeteoClient(transport: transport, clock: clock),
            ledger: SolarForecastRequestLedger(file: ledgerFile, clock: clock),
            cache: SolarForecastAutomaticCache(file: cacheFile),
            clock: clock
        )
    }
}

final class MutableSolarClock: SolarForecastClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    init(_ now: Date) { current = now }
    func now() -> Date { lock.withLock { current } }
    func advance(by seconds: TimeInterval) { lock.withLock { current.addTimeInterval(seconds) } }
}

actor InMemorySolarFile<Value: Codable & Sendable>: SolarForecastFileStoring {
    private(set) var value: Value?
    private(set) var saves = 0
    private var failSaves = false

    init(_ value: Value? = nil) { self.value = value }

    func load() async throws -> Value? { value }

    func save(_ newValue: Value) async throws {
        if failSaves { throw CocoaError(.fileWriteNoPermission) }
        saves += 1
        value = newValue
    }

    func setFailingSaves(_ failing: Bool) { failSaves = failing }
}

/// A third provider that exists only here, registered through composition alone: half-hour
/// intervals, a three-day horizon and its own attribution and freshness.
actor SyntheticForecastProvider: SolarForecastProviding {
    static let id = SolarForecastProviderID(rawValue: "synthetic-weather")
    nonisolated let descriptor = SolarForecastProviderDescriptor(
        id: SyntheticForecastProvider.id, displayName: "Synthetic Weather",
        attribution: "Forecast by Synthetic Weather.",
        requirement: .detectedLayout, providesCautiousPower: true,
        refreshThreshold: 3600, maximumUsableAge: 7200, modelVersion: "synthetic-1"
    )
    private let clock: any SolarForecastClock
    private var cache: [SolarForecastSiteScope: SolarForecastRawBatch] = [:]
    private(set) var refreshes = 0

    init(clock: any SolarForecastClock) { self.clock = clock }

    func configuration(for request: SolarForecastRequest) async -> SolarForecastConfiguration {
        guard request.location != nil, request.layout != nil else {
            return SolarForecastConfiguration(readiness: .notConfigured, fingerprint: "", cacheRevision: "")
        }
        return SolarForecastConfiguration(readiness: .ready, fingerprint: "synthetic", cacheRevision: "synthetic")
    }

    func refresh(_ request: SolarForecastRequest) async -> SolarForecastProviderResult {
        refreshes += 1
        let start = request.window.start
        let intervals = SolarProviderFixture.intervals(from: start, hours: 72, powerKw: 2, step: 1800).map {
            SolarForecastInterval(
                periodStart: $0.periodStart,
                periodEnd: $0.periodEnd,
                powerKw: 2,
                cautiousPowerKw: 1.5
            )
        }
        let batch = SolarForecastRawBatch(
            providerID: Self.id, fingerprint: "synthetic", cacheRevision: "synthetic", intervals: intervals,
            fetchedAt: clock.now(), acClipKw: nil
        )
        cache[request.scope] = batch
        return SolarForecastProviderResult(batch: batch, outcome: .refreshed)
    }

    func cachedForecast(for request: SolarForecastRequest) async -> SolarForecastRawBatch? { cache[request.scope] }
    func activateAccountScope(_ accountScopeID: String?) async {}
    func clearAccountData() async throws { cache.removeAll() }
}

actor OpenMeteoTestTransport: OpenMeteoTransport {
    var requests: [URLRequest] = []
    let body: Data
    let status: Int
    let host: String
    init(body: Data, status: Int = 200, host: String = "api.open-meteo.com") {
        self.body = body
        self.status = status
        self.host = host
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let url = try #require(URL(string: "https://\(host)/v1/forecast"))
        let response = try #require(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil))
        return (body, response)
    }
}

enum OpenMeteoFixture {
    static func body(start: Date, hours: Int = 72, missing: Bool = false) throws -> Data {
        let time = (0 ..< hours).map { start.addingTimeInterval(Double($0) * 3600).timeIntervalSince1970 }
        let values: [Double?] = (0 ..< hours).map { missing && $0 == 1 ? nil : 400 }
        return try JSONEncoder().encode(OpenMeteoFixtureBody(
            utcOffsetSeconds: 0,
            units: ["time": "unixtime", "shortwave_radiation": "W/m²",
                    "direct_normal_irradiance": "W/m²", "diffuse_radiation": "W/m²"],
            hourly: OpenMeteoFixtureHourly(time: time, ghi: values, dni: values, dhi: values)
        ))
    }
}

private struct OpenMeteoFixtureBody: Encodable {
    let utcOffsetSeconds: Int
    let units: [String: String]
    let hourly: OpenMeteoFixtureHourly
    enum CodingKeys: String, CodingKey {
        case utcOffsetSeconds = "utc_offset_seconds"
        case units = "hourly_units"
        case hourly
    }
}

private struct OpenMeteoFixtureHourly: Encodable {
    let time: [Double]
    let ghi: [Double?]
    let dni: [Double?]
    let dhi: [Double?]
    enum CodingKeys: String, CodingKey {
        case time
        case ghi = "shortwave_radiation"
        case dni = "direct_normal_irradiance"
        case dhi = "diffuse_radiation"
    }
}
