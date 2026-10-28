import CryptoKit
import Foundation

protocol SolarForecastClock: Sendable { func now() -> Date }

struct SystemSolarForecastClock: SolarForecastClock {
    func now() -> Date { Date() }
}

struct SolarForecastCredential: Codable, Equatable, Sendable {
    let accountScopeID: String
    let siteID: String
    let credentialID: String
    let resourceIDs: [String]
}

struct SolarForecastBatch: Codable, Equatable, Sendable {
    let credentialID: String
    let resourceIDs: [String]
    let intervals: [SolarForecastInterval]
    let fetchedAt: Date
}

struct SolarForecastBudget: Codable, Equatable, Sendable {
    var utcDay: Date
    var totalAttempts: Int
    var automaticAttempts: Int
    var deferredUntil: Date?
}

struct SolarForecastPersistedState: Codable, Sendable {
    var credentials: [String: SolarForecastCredential] = [:]
    var caches: [String: SolarForecastBatch] = [:]
    var budgets: [String: SolarForecastBudget] = [:]
    var budgetLinks: [String: String] = [:]
    var failedScopes: Set<String> = []
}

protocol SolarForecastPersistence: Sendable {
    func loadState() async throws -> SolarForecastPersistedState
    func saveState(_ state: SolarForecastPersistedState) async throws
}

enum SolarForecastRefreshFailure: Equatable, Sendable {
    case unauthorized
    case rateLimited
    case requestFailed
    case unknownResource
    case invalidForecast
    case storageFailure
    case cleanupFailure
    /// The forecast was fetched successfully but could not be written to disk.
    /// Deliberately distinct from `storageFailure`, which means a credential was
    /// quarantined: here the data is good and the key must survive.
    case saveFailed
}

enum SolarForecastRefreshResult: Equatable, Sendable {
    case refreshed
    case alreadyFresh
    case deferred
    case budgetExhausted
    case notConfigured
    case failed(SolarForecastRefreshFailure)
    case cancelled
}

protocol SolarForecastManaging: Sendable {
    func activateAccountScope(_ accountScopeID: String?) async
    func credential(accountScopeID: String, siteID: String) async -> SolarForecastCredential?
    func connect(apiKey: String, accountScopeID: String, siteID: String, resourceIDs: [String]?) async throws -> String
    func discoverSites(accountScopeID: String, siteID: String, manual: Bool) async throws -> [SolcastSite]
    func selectArrays(_ resourceIDs: [String], accountScopeID: String, siteID: String) async throws
    func refresh(accountScopeID: String, siteID: String, manual: Bool) async -> SolarForecastRefreshResult
    func cachedBatch(accountScopeID: String, siteID: String) async -> SolarForecastBatch?
    func isRecommendationUsable(accountScopeID: String, siteID: String) async -> Bool
    func budget(for accountScopeID: String, siteID: String) async -> SolarForecastBudget
    func disconnect(accountScopeID: String, siteID: String) async throws
    func signOut() async throws
    /// A fixed, credential-free sentence about the last failure, for diagnostics.
    var lastErrorDescription: String? { get async }
}

extension SolarForecastManaging {
    var lastErrorDescription: String? { get async { nil } }
}
