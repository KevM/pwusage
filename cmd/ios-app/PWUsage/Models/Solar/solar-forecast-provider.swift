import CryptoKit
import Foundation

/// A stable provider name. Unknown values (from a newer build's files) decode fine and simply
/// never match a registered provider.
struct SolarForecastProviderID: RawRepresentable, Codable, Hashable, Sendable {
    let rawValue: String
    static let solcast = SolarForecastProviderID(rawValue: "solcast")
    static let openMeteo = SolarForecastProviderID(rawValue: "open-meteo")
    static let forecastSolar = SolarForecastProviderID(rawValue: "forecast-solar")
}

enum SolarForecastProviderRequirement: Equatable, Sendable {
    /// The user connected the provider with their own key.
    case credential
    /// The provider works from the server-detected layout and home location.
    case detectedLayout
}

struct SolarForecastProviderDescriptor: Equatable, Sendable {
    let id: SolarForecastProviderID
    let displayName: String
    let attribution: String
    let requirement: SolarForecastProviderRequirement
    let providesCautiousPower: Bool
    /// A batch younger than this is not refetched.
    let refreshThreshold: TimeInterval
    /// A batch older than this is not used.
    let maximumUsableAge: TimeInterval
    /// Part of every configuration fingerprint, so changing the adapter's conversion starts
    /// new history rather than training on the old one.
    let modelVersion: String
}

struct SolarForecastSiteScope: Hashable, Codable, Sendable {
    let accountScopeID: String
    let siteID: String
}

struct SolarForecastRequest: Sendable {
    let scope: SolarForecastSiteScope
    let siteTimeZone: TimeZone
    /// The span a usable batch must cover.
    let window: DateInterval
    let manual: Bool
    let layout: SolarLayout?
    let location: SolarHomeLocation?
    /// Beta sites use only the automatic source; credentials cannot intercept or become fallback.
    var automaticOnly = false
}

enum SolarForecastReadiness: Equatable, Sendable {
    case ready
    /// Chosen by the user but not usable yet, such as a Solcast key without arrays.
    case setupRequired
    case notConfigured
}

struct SolarForecastConfiguration: Equatable, Sendable {
    let readiness: SolarForecastReadiness
    /// The semantic configuration: what the forecast depends on. History is partitioned by it.
    let fingerprint: String
    /// The fingerprint plus anything that only invalidates the cache, such as detection time.
    let cacheRevision: String

    static func fingerprint(_ parts: [String]) -> String {
        SHA256.hash(data: Data(parts.joined(separator: "|").utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// A provider's forecast as fetched, before any correction.
struct SolarForecastRawBatch: Codable, Equatable, Sendable {
    let providerID: SolarForecastProviderID
    let fingerprint: String
    let cacheRevision: String
    let intervals: [SolarForecastInterval]
    let fetchedAt: Date
    let acClipKw: Double?

    var coverage: DateInterval {
        let start = intervals.map(\.periodStart).min() ?? fetchedAt
        let end = intervals.map(\.periodEnd).max() ?? start
        return DateInterval(start: start, end: max(start, end))
    }

    func isUsable(for request: SolarForecastRequest, descriptor: SolarForecastProviderDescriptor, now: Date) -> Bool {
        let age = now.timeIntervalSince(fetchedAt)
        return age.isFinite && age >= 0 && age <= descriptor.maximumUsableAge
            && coverage.start <= request.window.start && coverage.end >= request.window.end
    }
}

enum SolarForecastFailureCategory: Equatable, Sendable {
    case transient
    case access
    case configuration
    case invalidResponse
}

enum SolarForecastRefreshOutcome: Equatable, Sendable {
    case fresh
    case refreshed
    case deferred(until: Date?)
    case budgetExhausted
    case setupRequired
    case unavailable
    case failed(SolarForecastFailureCategory)
    case cancelled
}

struct SolarForecastProviderResult: Equatable, Sendable {
    let batch: SolarForecastRawBatch?
    let outcome: SolarForecastRefreshOutcome
    /// A fixed, secret-free sentence for diagnostics.
    var diagnostic: String?
}

/// Every forecast source. Shared orchestration never switches on a provider's identity.
protocol SolarForecastProviding: Sendable {
    nonisolated var descriptor: SolarForecastProviderDescriptor { get }
    /// Readiness and identity, without fetching anything.
    func configuration(for request: SolarForecastRequest) async -> SolarForecastConfiguration
    func refresh(_ request: SolarForecastRequest) async -> SolarForecastProviderResult
    func cachedForecast(for request: SolarForecastRequest) async -> SolarForecastRawBatch?
    func activateAccountScope(_ accountScopeID: String?) async
    /// Clears account data. Device-wide request ledgers survive.
    func clearAccountData() async throws
}

/// The forecast the coordinator publishes: intervals and metadata, never credentials.
struct SolarForecastPublication: Equatable, Sendable {
    let descriptor: SolarForecastProviderDescriptor
    let intervals: [SolarForecastInterval]
    let fetchedAt: Date
    let coverage: DateInterval
    let fingerprint: String
    let configurationRevision: String
    let outcome: SolarForecastRefreshOutcome
    let diagnostic: String?
    var correction: SolarForecastCorrectionSummary = .identity
}

/// What correction was applied to a publication, for diagnostics.
struct SolarForecastCorrectionSummary: Equatable, Sendable {
    var sameDayFactors: [Int: Double] = [:]
    var dayAheadFactors: [Int: Double] = [:]
    var sameDaySamples = 0
    var dayAheadSamples = 0
    static let identity = SolarForecastCorrectionSummary()
}
