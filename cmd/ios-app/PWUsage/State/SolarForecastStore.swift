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
    case invalidForecast
    case storageFailure
    case cleanupFailure
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
}

actor SolarForecastStore {
    static let shared = SolarForecastStore()
    static let foregroundRefreshThreshold: TimeInterval = 3 * 60 * 60
    static let recommendationFreshness: TimeInterval = 6 * 60 * 60
    static let automaticAttemptsPerUTCDay = 8
    static let totalAttemptsPerUTCDay = 10

    private let clock: any SolarForecastClock
    private let keychain: any SolcastCredentialKeychain
    private let files: any SolarForecastPersistence
    private let transport: (any SolcastTransport)?
    private var state: SolarForecastPersistedState
    private var loaded = false
    private var generations: [String: Int] = [:]
    private struct InFlightRefresh {
        let id: UUID
        let task: Task<SolarForecastRefreshResult, Never>
    }

    private var inFlight: [String: InFlightRefresh] = [:]
    private var activeAccountScopeID: String?
    private(set) var lastErrorDescription: String?

    init(
        clock: any SolarForecastClock = SystemSolarForecastClock(),
        keychain: any SolcastCredentialKeychain = DeviceSolcastCredentialStore.shared,
        files: (any SolarForecastPersistence)? = nil,
        transport: (any SolcastTransport)? = nil
    ) {
        self.clock = clock
        self.keychain = keychain
        self.files = files ?? DeviceSolarForecastPersistence()
        self.transport = transport
        state = SolarForecastPersistedState()
    }

    @discardableResult
    func connect(apiKey: String, accountScopeID: String, siteID: String, resourceIDs: [String]? = nil) async throws -> String {
        try await loadIfNeeded()
        guard !apiKey.isEmpty, !accountScopeID.isEmpty, !siteID.isEmpty else { throw StoreError.invalidConfiguration }
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        let previousState = state
        let previousCredential = state.credentials[scope]
        let credentialID = Self.credentialID(for: apiKey)
        let selectedResources = resourceIDs
            ?? (previousCredential?.credentialID == credentialID ? previousCredential?.resourceIDs ?? [] : [])
        guard (0...2).contains(selectedResources.count), Set(selectedResources).count == selectedResources.count,
              selectedResources.allSatisfy({ !$0.isEmpty }) else { throw StoreError.invalidConfiguration }
        let previousKey = try await keychain.load(accountScopeID: accountScopeID, siteID: siteID)
        activateAccountScope(accountScopeID)
        invalidateRefresh(scope: scope)
        let credential = SolarForecastCredential(accountScopeID: accountScopeID, siteID: siteID, credentialID: credentialID, resourceIDs: selectedResources)
        try await keychain.save(key: apiKey, accountScopeID: accountScopeID, siteID: siteID, credentialID: credentialID)
        var nextState = previousState
        if previousCredential?.credentialID != credentialID || previousCredential?.resourceIDs != selectedResources {
            nextState.caches.removeValue(forKey: scope)
        }
        nextState.credentials[scope] = credential
        nextState.budgetLinks[scope] = credentialID
        do {
            try await files.saveState(nextState)
        } catch {
            do {
                if let previousKey {
                    try await keychain.save(key: previousKey.key, accountScopeID: accountScopeID, siteID: siteID, credentialID: previousKey.credentialID)
                } else {
                    try await keychain.delete(accountScopeID: accountScopeID, siteID: siteID)
                }
            } catch {
                state = previousState
                state.credentials.removeValue(forKey: scope)
                state.caches.removeValue(forKey: scope)
                state.budgetLinks.removeValue(forKey: scope)
                state.failedScopes.insert(scope)
                lastErrorDescription = "Forecast credential could not be safely saved"
                try? await persist()
                throw StoreError.cleanupFailed
            }
            state = previousState
            throw StoreError.persistenceFailed
        }
        state = nextState
        return credentialID
    }

    func credential(accountScopeID: String, siteID: String) async -> SolarForecastCredential? {
        try? await loadIfNeeded()
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard let credential = state.credentials[scope], await credentialHasMatchingKey(credential) else { return nil }
        return credential
    }

    func activateAccountScope(_ accountScopeID: String?) {
        guard accountScopeID != activeAccountScopeID else { return }
        if let previousAccountID = activeAccountScopeID {
            let affectedScopes = state.credentials.compactMap { key, credential in
                credential.accountScopeID == previousAccountID ? key : nil
            }
            for scope in affectedScopes { generations[scope, default: 0] += 1 }
        }
        for scope in Array(inFlight.keys) {
            generations[scope, default: 0] += 1
            inFlight[scope]?.task.cancel()
        }
        inFlight.removeAll()
        activeAccountScopeID = accountScopeID
    }

    func cachedBatch(accountScopeID: String, siteID: String) async -> SolarForecastBatch? {
        try? await loadIfNeeded()
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard let credential = state.credentials[scope], await credentialHasMatchingKey(credential),
              state.caches[scope]?.credentialID == credential.credentialID,
              state.caches[scope]?.resourceIDs == credential.resourceIDs else { return nil }
        return state.caches[scope]
    }

    func isRecommendationUsable(accountScopeID: String, siteID: String) async -> Bool {
        do { try await loadIfNeeded() } catch { return false }
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard !state.failedScopes.contains(scope), let batch = await cachedBatch(accountScopeID: accountScopeID, siteID: siteID) else { return false }
        let age = clock.now().timeIntervalSince(batch.fetchedAt)
        return age.isFinite && age >= 0 && age <= Self.recommendationFreshness
    }

    func budget(for accountScopeID: String, siteID: String) async -> SolarForecastBudget {
        try? await loadIfNeeded()
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard let credentialID = state.budgetLinks[scope] else { return Self.emptyBudget(at: clock.now()) }
        return normalizedBudget(state.budgets[credentialID], at: clock.now())
    }

    func discoverSites(accountScopeID: String, siteID: String, manual: Bool = false) async throws -> [SolcastSite] {
        try await loadIfNeeded()
        guard activeAccountScopeID == accountScopeID else { throw StoreError.notConfigured }
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard let credential = state.credentials[scope],
              let storedKey = try await keychain.load(accountScopeID: accountScopeID, siteID: siteID),
              credential.credentialID == storedKey.credentialID,
              Self.credentialID(for: storedKey.key) == credential.credentialID else { throw StoreError.notConfigured }
        let generation = generations[scope, default: 0]
        if let deferredUntil = normalizedBudget(state.budgets[credential.credentialID], at: clock.now()).deferredUntil,
           deferredUntil > clock.now() { throw StoreError.deferred }
        guard reserveRequests(1, credentialID: credential.credentialID, manual: manual) else {
            let outcome = await persistFailureState(scope: scope, credential: credential, description: "Forecast request budget is exhausted")
            throw Self.discoveryError(for: outcome, ordinaryError: .budgetExhausted)
        }
        do { try await persist() } catch {
            let outcome = await persistFailureState(scope: scope, credential: credential, description: "Forecast request budget could not be saved")
            throw Self.discoveryError(for: outcome, ordinaryError: .persistenceFailed)
        }
        guard generation == generations[scope], activeAccountScopeID == accountScopeID,
              state.credentials[scope]?.credentialID == credential.credentialID else { throw StoreError.cancelled }
        do {
            let sites = try await SolcastClient(apiKey: storedKey.key, transport: transport).discoverSites()
            guard generation == generations[scope], activeAccountScopeID == accountScopeID,
                  state.credentials[scope]?.credentialID == credential.credentialID else { throw StoreError.cancelled }
            return sites
        } catch let error as SolcastClientError {
            guard generation == generations[scope], activeAccountScopeID == accountScopeID else { throw StoreError.cancelled }
            recordRateLimit(error, credentialID: credential.credentialID)
            let outcome = await persistFailureState(scope: scope, credential: credential, description: Self.safeDescription(error))
            guard outcome == .persisted else { throw Self.discoveryError(for: outcome, ordinaryError: .persistenceFailed) }
            throw StoreError.discoveryFailed(Self.failureKind(error))
        } catch {
            guard generation == generations[scope], activeAccountScopeID == accountScopeID else { throw StoreError.cancelled }
            let outcome = await persistFailureState(scope: scope, credential: credential, description: "Forecast request failed")
            guard outcome == .persisted else { throw Self.discoveryError(for: outcome, ordinaryError: .persistenceFailed) }
            throw StoreError.discoveryFailed(.requestFailed)
        }
    }

    func selectArrays(_ resourceIDs: [String], accountScopeID: String, siteID: String) async throws {
        try await loadIfNeeded()
        guard activeAccountScopeID == accountScopeID,
              (1...2).contains(resourceIDs.count), Set(resourceIDs).count == resourceIDs.count,
              resourceIDs.allSatisfy({ !$0.isEmpty }) else { throw StoreError.invalidConfiguration }
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard let currentCredential = state.credentials[scope], await credentialHasMatchingKey(currentCredential) else { throw StoreError.notConfigured }
        invalidateRefresh(scope: scope)
        var nextState = state
        nextState.credentials[scope] = SolarForecastCredential(accountScopeID: accountScopeID, siteID: siteID, credentialID: currentCredential.credentialID, resourceIDs: resourceIDs)
        nextState.caches.removeValue(forKey: scope)
        do { try await files.saveState(nextState) } catch { throw StoreError.persistenceFailed }
        state = nextState
    }

    func refresh(accountScopeID: String, siteID: String, manual: Bool = false) async -> SolarForecastRefreshResult {
        do { try await loadIfNeeded() } catch { return .failed(.requestFailed) }
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        guard activeAccountScopeID == accountScopeID else { return .notConfigured }
        if let existing = inFlight[scope] { return await existing.task.value }
        guard let credential = state.credentials[scope], credential.resourceIDs.count > 0 else { return .notConfigured }
        if !manual,
           let batch = state.caches[scope], batch.credentialID == credential.credentialID,
           clock.now().timeIntervalSince(batch.fetchedAt).isFinite,
           clock.now().timeIntervalSince(batch.fetchedAt) >= 0,
           clock.now().timeIntervalSince(batch.fetchedAt) < Self.foregroundRefreshThreshold {
            return .alreadyFresh
        }
        if let credentialID = state.budgetLinks[scope],
           normalizedBudget(state.budgets[credentialID], at: clock.now()).deferredUntil.map({ $0 > clock.now() }) == true {
            return .deferred
        }
        let generation = generations[scope, default: 0]
        let refreshID = UUID()
        let task = Task { await self.performRefresh(scope: scope, credential: credential, generation: generation, manual: manual) }
        inFlight[scope] = InFlightRefresh(id: refreshID, task: task)
        let result = await task.value
        if inFlight[scope]?.id == refreshID { inFlight.removeValue(forKey: scope) }
        return result
    }

    func disconnect(accountScopeID: String, siteID: String) async throws {
        try await loadIfNeeded()
        let scope = SolarForecastScope.key(accountScopeID, siteID)
        generations[scope, default: 0] += 1
        inFlight[scope]?.task.cancel()
        inFlight.removeValue(forKey: scope)
        var failed = false
        do { try await keychain.delete(accountScopeID: accountScopeID, siteID: siteID) } catch { failed = true }
        state.credentials.removeValue(forKey: scope)
        state.caches.removeValue(forKey: scope)
        state.budgetLinks.removeValue(forKey: scope)
        state.failedScopes.remove(scope)
        lastErrorDescription = nil
        if activeAccountScopeID == accountScopeID,
           !state.credentials.values.contains(where: { $0.accountScopeID == accountScopeID }) {
            activeAccountScopeID = nil
        }
        do { try await persist() } catch { failed = true }
        if failed { throw StoreError.cleanupFailed }
    }

    func signOut() async throws {
        do { try await loadIfNeeded() } catch { loaded = true }
        let scopes = Set(Array(state.credentials.keys) + Array(state.caches.keys) + Array(inFlight.keys) + Array(generations.keys))
        for scope in scopes {
            generations[scope, default: 0] += 1
            inFlight[scope]?.task.cancel()
            inFlight.removeValue(forKey: scope)
        }
        activeAccountScopeID = nil
        state.credentials.removeAll()
        state.caches.removeAll()
        state.budgetLinks.removeAll()
        state.failedScopes.removeAll()
        lastErrorDescription = nil
        var failed = false
        do { try await persist() } catch { failed = true }
        do { try await keychain.deleteAllCredentials() } catch { failed = true }
        if failed { throw StoreError.cleanupFailed }
    }

    private func invalidateRefresh(scope: String) {
        generations[scope, default: 0] += 1
        inFlight[scope]?.task.cancel()
        inFlight.removeValue(forKey: scope)
    }

    private func performRefresh(scope: String, credential: SolarForecastCredential, generation: Int, manual: Bool) async -> SolarForecastRefreshResult {
        guard let storedKey = try? await keychain.load(accountScopeID: credential.accountScopeID, siteID: credential.siteID),
              storedKey.credentialID == credential.credentialID,
              Self.credentialID(for: storedKey.key) == credential.credentialID else {
            let outcome = await persistFailureState(scope: scope, credential: credential, description: "Forecast credential is unavailable")
            switch outcome {
            case .persisted: return .notConfigured
            case .quarantined: return .failed(.storageFailure)
            case .cleanupFailed: return .failed(.cleanupFailure)
            }
        }
        guard generation == generations[scope], activeAccountScopeID == credential.accountScopeID,
              state.credentials[scope]?.credentialID == credential.credentialID else { return .cancelled }
        let requestCount = credential.resourceIDs.count
        guard reserveRequests(requestCount, credentialID: credential.credentialID, manual: manual) else {
            let outcome = await persistFailureState(scope: scope, credential: credential, description: "Forecast request budget is exhausted")
            return Self.refreshResult(for: outcome, ordinaryResult: .budgetExhausted)
        }
        do { try await persist() } catch {
            let outcome = await persistFailureState(scope: scope, credential: credential, description: "Forecast request budget could not be saved")
            return Self.refreshResult(for: outcome, ordinaryResult: .failed(.requestFailed))
        }
        guard generation == generations[scope], activeAccountScopeID == credential.accountScopeID,
              state.credentials[scope]?.credentialID == credential.credentialID else { return .cancelled }
        let client = SolcastClient(apiKey: storedKey.key, transport: transport)
        do {
            var arrays: [[SolcastForecastPoint]] = []
            for resourceID in credential.resourceIDs {
                try Task.checkCancellation()
                arrays.append(try await client.fetchForecast(resourceID: resourceID))
            }
            try Task.checkCancellation()
            guard generation == generations[scope], activeAccountScopeID == credential.accountScopeID,
                  state.credentials[scope]?.credentialID == credential.credentialID else { return .cancelled }
            let intervals = try SolarForecast.combine(arrays)
            state.caches[scope] = SolarForecastBatch(credentialID: credential.credentialID, resourceIDs: credential.resourceIDs, intervals: intervals, fetchedAt: clock.now())
            state.failedScopes.remove(scope)
            lastErrorDescription = nil
            try await persist()
            return .refreshed
        } catch let error as SolcastClientError {
            guard generation == generations[scope], activeAccountScopeID == credential.accountScopeID else { return .cancelled }
            recordRateLimit(error, credentialID: credential.credentialID)
            let outcome = await persistFailureState(scope: scope, credential: credential, description: Self.safeDescription(error))
            return outcome == .persisted ? Self.refreshFailure(error) : Self.refreshResult(for: outcome, ordinaryResult: Self.refreshFailure(error))
        } catch is CancellationError {
            return .cancelled
        } catch {
            guard generation == generations[scope], activeAccountScopeID == credential.accountScopeID else { return .cancelled }
            let outcome = await persistFailureState(scope: scope, credential: credential, description: "Forecast request failed")
            let failure: SolarForecastRefreshFailure = (error as? SolarForecastError) == nil ? .requestFailed : .invalidForecast
            return Self.refreshResult(for: outcome, ordinaryResult: .failed(failure))
        }
    }

    private func persistFailureState(scope: String, credential: SolarForecastCredential, description: String) async -> FailurePersistenceOutcome {
        state.failedScopes.insert(scope)
        lastErrorDescription = description
        do {
            try await persist()
            return .persisted
        } catch {
            guard await quarantineCredential(accountScopeID: credential.accountScopeID, siteID: credential.siteID) else {
                lastErrorDescription = "Forecast data could not be safely disabled"
                return .cleanupFailed
            }
            lastErrorDescription = "Forecast data was disabled because it could not be saved"
            return .quarantined
        }
    }

    private func quarantineCredential(accountScopeID: String, siteID: String) async -> Bool {
        do {
            try await keychain.delete(accountScopeID: accountScopeID, siteID: siteID)
            return true
        } catch {
            do {
                guard let stored = try await keychain.load(accountScopeID: accountScopeID, siteID: siteID) else { return true }
                try await keychain.save(
                    key: stored.key,
                    accountScopeID: accountScopeID,
                    siteID: siteID,
                    credentialID: Self.quarantinedCredentialID
                )
                return true
            } catch {
                return false
            }
        }
    }

    private static let quarantinedCredentialID = "credential-quarantined"

    private enum FailurePersistenceOutcome: Equatable {
        case persisted
        case quarantined
        case cleanupFailed
    }

    private static func refreshResult(for outcome: FailurePersistenceOutcome, ordinaryResult: SolarForecastRefreshResult) -> SolarForecastRefreshResult {
        switch outcome {
        case .persisted: ordinaryResult
        case .quarantined: .failed(.storageFailure)
        case .cleanupFailed: .failed(.cleanupFailure)
        }
    }

    private static func discoveryError(for outcome: FailurePersistenceOutcome, ordinaryError: StoreError) -> StoreError {
        switch outcome {
        case .persisted: ordinaryError
        case .quarantined: .persistenceFailed
        case .cleanupFailed: .cleanupFailed
        }
    }

    private func reserveRequests(_ count: Int, credentialID: String, manual: Bool) -> Bool {
        let now = clock.now()
        var budget = normalizedBudget(state.budgets[credentialID], at: now)
        guard budget.deferredUntil.map({ $0 <= now }) ?? true else { return false }
        guard budget.totalAttempts + count <= Self.totalAttemptsPerUTCDay else { return false }
        if !manual, budget.automaticAttempts + count > Self.automaticAttemptsPerUTCDay { return false }
        budget.totalAttempts += count
        if !manual { budget.automaticAttempts += count }
        state.budgets[credentialID] = budget
        return true
    }

    private func recordRateLimit(_ error: SolcastClientError, credentialID: String) {
        guard case let .httpStatus(statusCode, retryAfter) = error, statusCode == 429 else { return }
        let now = clock.now()
        let deferred: Date
        if let retryAfter {
            switch retryAfter {
            case let .delay(seconds): deferred = now.addingTimeInterval(max(0, seconds))
            case let .date(date): deferred = max(now, date)
            }
        } else {
            deferred = Self.utcDayStart(now).addingTimeInterval(24 * 60 * 60)
        }
        var budget = normalizedBudget(state.budgets[credentialID], at: now)
        budget.deferredUntil = deferred
        state.budgets[credentialID] = budget
    }

    private func normalizedBudget(_ stored: SolarForecastBudget?, at date: Date) -> SolarForecastBudget {
        let day = Self.utcDayStart(date)
        guard let stored else { return Self.emptyBudget(at: date) }
        guard stored.utcDay != day else { return stored }
        return SolarForecastBudget(
            utcDay: day,
            totalAttempts: 0,
            automaticAttempts: 0,
            deferredUntil: stored.deferredUntil.flatMap { $0 > date ? $0 : nil }
        )
    }

    private static func emptyBudget(at date: Date) -> SolarForecastBudget {
        SolarForecastBudget(utcDay: utcDayStart(date), totalAttempts: 0, automaticAttempts: 0, deferredUntil: nil)
    }

    private static func utcDayStart(_ date: Date) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar.startOfDay(for: date)
    }

    private static func credentialID(for key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func safeDescription(_ error: SolcastClientError) -> String {
        switch error {
        case .httpStatus(let status, _): return "Forecast service returned HTTP \(status)"
        case .transportFailure: return "Forecast network request failed"
        case .invalidResourceID, .invalidResponse, .decodingFailure: return "Forecast response could not be used"
        }
    }

    private static func refreshFailure(_ error: SolcastClientError) -> SolarForecastRefreshResult {
        .failed(failureKind(error))
    }

    private static func failureKind(_ error: SolcastClientError) -> SolarForecastRefreshFailure {
        if case let .httpStatus(statusCode, _) = error, statusCode == 401 || statusCode == 403 { return .unauthorized }
        if case let .httpStatus(statusCode, _) = error, statusCode == 429 { return .rateLimited }
        return error == .decodingFailure ? .invalidForecast : .requestFailed
    }

    private func credentialHasMatchingKey(_ credential: SolarForecastCredential) async -> Bool {
        do {
            guard let stored = try await keychain.load(accountScopeID: credential.accountScopeID, siteID: credential.siteID),
                  stored.credentialID == credential.credentialID,
                  Self.credentialID(for: stored.key) == credential.credentialID else {
                state.failedScopes.insert(SolarForecastScope.key(credential.accountScopeID, credential.siteID))
                return false
            }
            return true
        } catch {
            state.failedScopes.insert(SolarForecastScope.key(credential.accountScopeID, credential.siteID))
            return false
        }
    }

    private func loadIfNeeded() async throws {
        guard !loaded else { return }
        state = try await files.loadState()
        loaded = true
    }

    private func persist() async throws { try await files.saveState(state) }

    enum StoreError: Error, Equatable { case invalidConfiguration, notConfigured, budgetExhausted, deferred, requestFailed, discoveryFailed(SolarForecastRefreshFailure), persistenceFailed, cleanupFailed, cancelled }
}

extension SolarForecastStore: SolarForecastManaging {}

actor DeviceSolarForecastPersistence: SolarForecastPersistence {
    private let fileURL: URL
    private var cached: SolarForecastPersistedState?

    init(fileManager: FileManager = .default) {
        let directory = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("SolarForecast", isDirectory: true)
        fileURL = directory.appendingPathComponent("state.json", isDirectory: false)
    }

    func loadState() throws -> SolarForecastPersistedState {
        if let cached { return cached }
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return SolarForecastPersistedState() }
        let data = try Data(contentsOf: fileURL)
        let state = try JSONDecoder().decode(SolarForecastPersistedState.self, from: data)
        cached = state
        return state
    }

    func saveState(_ state: SolarForecastPersistedState) throws {
        let manager = FileManager.default
        try manager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var directoryValues = URLResourceValues()
        directoryValues.isExcludedFromBackup = true
        var directory = fileURL.deletingLastPathComponent()
        try directory.setResourceValues(directoryValues)
        try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directory.path)
        let data = try JSONEncoder().encode(state)
        try data.write(to: fileURL, options: .atomic)
        try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: fileURL.path)
        var fileValues = URLResourceValues()
        fileValues.isExcludedFromBackup = true
        var protectedFile = fileURL
        try protectedFile.setResourceValues(fileValues)
        cached = state
    }

    func clearConnections() throws {
        var current = (try? loadState()) ?? SolarForecastPersistedState()
        current.credentials.removeAll()
        current.caches.removeAll()
        current.budgetLinks.removeAll()
        current.failedScopes.removeAll()
        try saveState(current)
    }
}

@MainActor
struct SolarForecastStoreSessionCleanup: SolarForecastSessionCleanup {
    let store: SolarForecastStore
    func signOut() async throws { try await store.signOut() }
}
