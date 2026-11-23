import CryptoKit
import Foundation

/// A stable provider name. Unknown values (from a newer build's files) decode fine and simply
/// never match a registered provider.
public struct SolarForecastProviderID: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public static let openMeteo = SolarForecastProviderID(rawValue: "open-meteo")

    public init(rawValue: String) {
        self.rawValue = rawValue
    }
}

public enum SolarForecastProviderRequirement: Equatable, Sendable {
    /// The provider works from the server-detected layout and home location.
    case detectedLayout
}

public struct SolarForecastProviderDescriptor: Equatable, Sendable {
    public let id: SolarForecastProviderID
    public let displayName: String
    public let attribution: String
    public let requirement: SolarForecastProviderRequirement
    public let providesCautiousPower: Bool
    /// A batch younger than this is not refetched.
    public let refreshThreshold: TimeInterval
    /// A batch older than this is not used.
    public let maximumUsableAge: TimeInterval
    /// Part of every configuration fingerprint, so changing the adapter's conversion starts
    /// new history rather than training on the old one.
    public let modelVersion: String
    public var attributionURL: URL?

    public init(
        id: SolarForecastProviderID,
        displayName: String,
        attribution: String,
        requirement: SolarForecastProviderRequirement,
        providesCautiousPower: Bool,
        refreshThreshold: TimeInterval,
        maximumUsableAge: TimeInterval,
        modelVersion: String,
        attributionURL: URL? = nil
    ) {
        self.id = id
        self.displayName = displayName
        self.attribution = attribution
        self.requirement = requirement
        self.providesCautiousPower = providesCautiousPower
        self.refreshThreshold = refreshThreshold
        self.maximumUsableAge = maximumUsableAge
        self.modelVersion = modelVersion
        self.attributionURL = attributionURL
    }
}

public struct SolarForecastRequest: Sendable {
    public let scope: SolarForecastSiteScope
    public let siteTimeZone: TimeZone
    /// The span a usable batch must cover.
    public let window: DateInterval
    public let manual: Bool
    public let layout: SolarLayout?
    public let location: SolarHomeLocation?
    /// Automatic forecasting uses only this source; credentials cannot intercept or become fallback.
    public var automaticOnly = false

    public init(
        scope: SolarForecastSiteScope,
        siteTimeZone: TimeZone,
        window: DateInterval,
        manual: Bool,
        layout: SolarLayout?,
        location: SolarHomeLocation?,
        automaticOnly: Bool = false
    ) {
        self.scope = scope
        self.siteTimeZone = siteTimeZone
        self.window = window
        self.manual = manual
        self.layout = layout
        self.location = location
        self.automaticOnly = automaticOnly
    }
}

public enum SolarForecastReadiness: Equatable, Sendable {
    case ready
    /// Chosen by the user but not usable yet, such as a Solcast key without arrays.
    case setupRequired
    case notConfigured
}

public struct SolarForecastConfiguration: Equatable, Sendable {
    public let readiness: SolarForecastReadiness
    /// The semantic configuration: what the forecast depends on. History is partitioned by it.
    public let fingerprint: String
    /// The fingerprint plus anything that only invalidates the cache, such as detection time.
    public let cacheRevision: String

    public init(readiness: SolarForecastReadiness, fingerprint: String, cacheRevision: String) {
        self.readiness = readiness
        self.fingerprint = fingerprint
        self.cacheRevision = cacheRevision
    }

    public static func fingerprint(_ parts: [String]) -> String {
        SHA256.hash(data: Data(parts.joined(separator: "|").utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// A provider's forecast as fetched, before any correction.
public struct SolarForecastRawBatch: Codable, Equatable, Sendable {
    public let providerID: SolarForecastProviderID
    public let fingerprint: String
    public let cacheRevision: String
    public let intervals: [SolarForecastInterval]
    public let fetchedAt: Date
    public let acClipKw: Double?

    public init(
        providerID: SolarForecastProviderID,
        fingerprint: String,
        cacheRevision: String,
        intervals: [SolarForecastInterval],
        fetchedAt: Date,
        acClipKw: Double?
    ) {
        self.providerID = providerID
        self.fingerprint = fingerprint
        self.cacheRevision = cacheRevision
        self.intervals = intervals
        self.fetchedAt = fetchedAt
        self.acClipKw = acClipKw
    }

    public var coverage: DateInterval {
        let start = intervals.map(\.periodStart).min() ?? fetchedAt
        let end = intervals.map(\.periodEnd).max() ?? start
        return DateInterval(start: start, end: max(start, end))
    }

    public func isUsable(
        for request: SolarForecastRequest,
        descriptor: SolarForecastProviderDescriptor,
        now: Date
    ) -> Bool {
        let age = now.timeIntervalSince(fetchedAt)
        return age.isFinite && age >= 0 && age <= descriptor.maximumUsableAge
            && coverage.start <= request.window.start && coverage.end >= request.window.end
    }
}

public enum SolarForecastFailureCategory: Equatable, Sendable {
    case transient
    case access
    case configuration
    case invalidResponse
}

public enum SolarForecastRefreshOutcome: Equatable, Sendable {
    case fresh
    case refreshed
    case deferred(until: Date?)
    case budgetExhausted
    case setupRequired
    case unavailable
    case failed(SolarForecastFailureCategory)
    case cancelled
}

public struct SolarForecastProviderResult: Equatable, Sendable {
    public let batch: SolarForecastRawBatch?
    public let outcome: SolarForecastRefreshOutcome
    /// A fixed, secret-free sentence for diagnostics.
    public var diagnostic: String?

    public init(batch: SolarForecastRawBatch?, outcome: SolarForecastRefreshOutcome, diagnostic: String? = nil) {
        self.batch = batch
        self.outcome = outcome
        self.diagnostic = diagnostic
    }
}

/// Every forecast source. Shared orchestration never switches on a provider's identity.
public protocol SolarForecastProviding: Sendable {
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
public struct SolarForecastPublication: Equatable, Sendable {
    public let descriptor: SolarForecastProviderDescriptor
    public let intervals: [SolarForecastInterval]
    public let fetchedAt: Date
    public let coverage: DateInterval
    public let fingerprint: String
    public let configurationRevision: String
    public let outcome: SolarForecastRefreshOutcome
    public let diagnostic: String?
    public var correction: SolarForecastCorrectionSummary = .identity

    public init(
        descriptor: SolarForecastProviderDescriptor,
        intervals: [SolarForecastInterval],
        fetchedAt: Date,
        coverage: DateInterval,
        fingerprint: String,
        configurationRevision: String,
        outcome: SolarForecastRefreshOutcome,
        diagnostic: String?,
        correction: SolarForecastCorrectionSummary = .identity
    ) {
        self.descriptor = descriptor
        self.intervals = intervals
        self.fetchedAt = fetchedAt
        self.coverage = coverage
        self.fingerprint = fingerprint
        self.configurationRevision = configurationRevision
        self.outcome = outcome
        self.diagnostic = diagnostic
        self.correction = correction
    }
}

/// What correction was applied to a publication, for diagnostics.
public struct SolarForecastCorrectionSummary: Equatable, Sendable {
    public var sameDayFactors: [Int: Double] = [:]
    public var dayAheadFactors: [Int: Double] = [:]
    public var sameDaySamples = 0
    public var dayAheadSamples = 0
    public static let identity = SolarForecastCorrectionSummary()

    public init(
        sameDayFactors: [Int: Double] = [:],
        dayAheadFactors: [Int: Double] = [:],
        sameDaySamples: Int = 0,
        dayAheadSamples: Int = 0
    ) {
        self.sameDayFactors = sameDayFactors
        self.dayAheadFactors = dayAheadFactors
        self.sameDaySamples = sameDaySamples
        self.dayAheadSamples = dayAheadSamples
    }
}

/// Preserves an attempted refresh even when history must be used instead of a forecast.
public struct SolarForecastPublicationAttempt: Sendable {
    public var publication: SolarForecastPublication?
    public var providerID: SolarForecastProviderID?
    public var outcome: SolarForecastRefreshOutcome
    public var diagnostic: String?

    public init(
        publication: SolarForecastPublication? = nil,
        providerID: SolarForecastProviderID? = nil,
        outcome: SolarForecastRefreshOutcome,
        diagnostic: String? = nil
    ) {
        self.publication = publication
        self.providerID = providerID
        self.outcome = outcome
        self.diagnostic = diagnostic
    }

    public var unavailableCause: SolarForecastUnavailableCause? {
        switch outcome {
        case .failed(.access): .unauthorized
        case .failed(.invalidResponse), .failed(.configuration): .invalidForecast
        case .failed(.transient): .requestFailed
        case .budgetExhausted: .budgetExhausted
        case .deferred: .deferred
        case .unavailable: .invalidForecast
        default: nil
        }
    }
}
