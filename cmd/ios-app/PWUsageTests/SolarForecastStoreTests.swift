import Foundation
import Testing
@testable import PWUsage

@Suite("Solar Forecast Store Tests", .serialized)
struct SolarForecastStoreTests {
    @Test("Concurrent refreshes share one complete request batch")
    func concurrentRefreshesShareOneBatch() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east", "west"])
        await h.transport.holdResponses()
        async let first = h.store.refresh(accountScopeID: "account-a", siteID: "site-a")
        await h.transport.waitUntilRequestsStarted(1)
        async let second = h.store.refresh(accountScopeID: "account-a", siteID: "site-a")
        await h.transport.resumeResponses()
        let results = await (first, second)
        #expect(results.0 == .refreshed)
        #expect(results.1 == .refreshed)
        #expect(await h.transport.requestCount == 2)
    }

    /// A device that keeps a saved key and array selection across a relaunch, on a
    /// new UTC day, with no usable cache. This is the "I redeployed and see no
    /// attempts" scenario: the in-memory account scope and cache are both gone.
    @Test("A saved selection still requests on a new day after a relaunch")
    func savedSelectionRequestsOnNewDayAfterRelaunch() async throws {
        let dayOne = Self.date("2026-09-27T12:00:00Z")
        let h = Harness(now: dayOne)
        let credentialID = try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        _ = await h.store.refresh(accountScopeID: "account-a", siteID: "site-a")
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 1)

        // Relaunch: a brand new store over the same keychain and files, one day later.
        let dayTwo = Self.date("2026-09-28T09:00:00Z")
        let relaunched = Harness(now: dayTwo)
        try await relaunched.keychain.save(key: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", credentialID: credentialID)
        try await relaunched.files.saveState(await h.files.loadState())
        await relaunched.store.activateAccountScope("account-a")

        // The selection must be visible, which is what the settings sheet shows.
        let credential = try #require(await relaunched.store.credential(accountScopeID: "account-a", siteID: "site-a"))
        #expect(credential.resourceIDs == ["east"])
        #expect(await relaunched.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 0)

        let result = await relaunched.store.refresh(accountScopeID: "account-a", siteID: "site-a")

        #expect(result == .refreshed, "A saved selection must still request on a new day")
        #expect(await relaunched.transport.requestCount == 1)
        let budget = await relaunched.store.budget(for: "account-a", siteID: "site-a")
        #expect(budget.totalAttempts == 1)
        #expect(budget.automaticAttempts == 1)
    }

    @Test("A 404 names the array as unknown rather than reporting a network fault")
    func unknownResourceIsNotReportedAsUnreachable() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.transport.nextStatusCode(404)

        let result = await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true)

        #expect(result == .failed(.unknownResource))
        // The attempt is still charged, so the note should say so.
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 1)
    }

    @Test("UTC day rollover resets attempt counters")
    func utcDayRolloverResetsBudget() async throws {
        let h = Harness(now: Self.date("2026-09-27T23:59:00Z"))
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        _ = await h.store.refresh(accountScopeID: "account-a", siteID: "site-a")
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 1)
        h.clock.advance(by: 120)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 0)
    }

    @Test("A two array refresh reserves its full request count before dispatch")
    func reservesSelectedArrayRequestCount() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east", "west"])
        let refresh = Task { await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") }
        await h.transport.waitUntilRequestsStarted(1)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 2)
        await h.transport.resumeResponses()
        #expect(await refresh.value == .refreshed)
    }

    @Test("Failures consume the persisted budget and retries cannot exceed the automatic cap")
    func failuresConsumeBudget() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.transport.failNext(3)
        for _ in 0..<3 { _ = await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") }
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 3)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").automaticAttempts == 3)
    }

    @Test("401 disables the failed refresh without exposing the key")
    func unauthorizedDoesNotExposeKey() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.transport.nextStatusCode(401)
        let result = await h.store.refresh(accountScopeID: "account-a", siteID: "site-a")
        #expect(result == .failed(.unauthorized))
        #expect(await h.store.lastErrorDescription?.contains("synthetic-key") == false)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("429 defers further requests until sanitized Retry-After")
    func rateLimitHonorsRetryAfter() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.transport.nextRateLimitDelay(600)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .failed(.rateLimited))
        let count = await h.transport.requestCount
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .deferred)
        #expect(await h.transport.requestCount == count)
        h.clock.advance(by: 601)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
    }

    @Test("429 without Retry-After defers until the next UTC day")
    func rateLimitWithoutHeaderDefersToUTCReset() async throws {
        let h = Harness(now: Self.date("2026-09-27T23:59:00Z"))
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.transport.nextStatusCode(429)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .failed(.rateLimited))
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .deferred)
        h.clock.advance(by: 120)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
    }

    @Test("Automatic refresh stops after eight reserved array attempts")
    func automaticAttemptsStopAtEight() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east", "west"])
        await h.transport.failNext(4)
        for _ in 0..<4 {
            #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .failed(.requestFailed))
        }
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").automaticAttempts == 8)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .budgetExhausted)
    }

    @Test("Disconnect rejects a late forecast completion")
    func disconnectRejectsLateCompletion() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.transport.holdResponses()
        let request = Task { await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") }
        await h.transport.waitUntilRequestsStarted(1)
        try await h.store.disconnect(accountScopeID: "account-a", siteID: "site-a")
        await h.transport.resumeResponses()
        #expect(await request.value == .cancelled)
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == nil)
    }

    @Test("Changing account scope rejects an in-flight completion")
    func accountChangeRejectsLateCompletion() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.transport.holdResponses()
        let request = Task { await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") }
        await h.transport.waitUntilRequestsStarted(1)
        await h.store.activateAccountScope("account-b")
        await h.transport.resumeResponses()
        #expect(await request.value == .cancelled)
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == nil)
    }

    @Test("A six hour old batch is visible as stale but cannot recommend")
    func staleCacheCannotRecommend() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        h.clock.advance(by: SolarForecastStore.recommendationFreshness + 1)
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") != nil)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("A failed second array keeps the previous complete batch")
    func failedSecondArrayPreservesCompleteBatch() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east", "west"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        let previous = await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a")
        await h.transport.failResourceID("west")
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.requestFailed))
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == previous)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("Account and site switches cannot read another association or cache")
    func accountAndSiteSwitchesAreIsolated() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        _ = await h.store.refresh(accountScopeID: "account-a", siteID: "site-a")
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") != nil)
        #expect(await h.store.cachedBatch(accountScopeID: "account-b", siteID: "site-a") == nil)
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-b") == nil)
    }

    @Test("Replacing a key uses a new nonsecret credential identifier")
    func keyReplacementGetsNewCredentialID() async throws {
        let h = Harness()
        let first = try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        let second = try await h.store.connect(apiKey: "key-b", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(first != second)
        #expect(!second.contains("key-b"))
    }

    @Test("Changing selected arrays invalidates a cache for the old selection")
    func changingSelectionInvalidatesCache() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east", "west"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == nil)
    }

    @Test("Replacing a key during refresh invalidates the old task instead of reusing it")
    func keyReplacementInvalidatesInFlightRefresh() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.transport.holdResponses()
        let oldRefresh = Task { await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) }
        await h.transport.waitUntilRequestsStarted(1)

        try await h.store.connect(apiKey: "key-b", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["west"])
        let newRefresh = Task { await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) }
        try await Task.sleep(for: .milliseconds(10))

        #expect(await h.transport.requestCount == 2)
        await h.transport.resumeResponses()
        #expect(await oldRefresh.value == .cancelled)
        #expect(await newRefresh.value == .refreshed)
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a")?.resourceIDs == ["west"])
    }

    @Test("Changing array selection during refresh invalidates the old task instead of reusing it")
    func selectionChangeInvalidatesInFlightRefresh() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.transport.holdResponses()
        let oldRefresh = Task { await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) }
        await h.transport.waitUntilRequestsStarted(1)

        try await h.store.selectArrays(["west"], accountScopeID: "account-a", siteID: "site-a")
        let newRefresh = Task { await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) }
        try await Task.sleep(for: .milliseconds(10))

        #expect(await h.transport.requestCount == 2)
        await h.transport.resumeResponses()
        #expect(await oldRefresh.value == .cancelled)
        #expect(await newRefresh.value == .refreshed)
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a")?.resourceIDs == ["west"])
    }

    @Test("A different replacement key requires explicit array selection")
    func replacementKeyClearsPriorSelection() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])

        try await h.store.connect(apiKey: "key-b", accountScopeID: "account-a", siteID: "site-a")

        #expect(await h.store.credential(accountScopeID: "account-a", siteID: "site-a")?.resourceIDs == [])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .notConfigured)
    }

    @Test("Disconnect removes key, mapping and cache while preserving nonsecret budget")
    func disconnectCleansAssociationButKeepsBudget() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        _ = await h.store.refresh(accountScopeID: "account-a", siteID: "site-a")
        let before = await h.store.budget(for: "account-a", siteID: "site-a")
        try await h.store.disconnect(accountScopeID: "account-a", siteID: "site-a")
        #expect(await h.keychain.count == 0)
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == nil)
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.budget(for: "account-a", siteID: "site-a") == before)
    }

    @Test("Sign-out clears all associations and caches for the local account scope")
    func signOutClearsAccountState() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        _ = await h.store.refresh(accountScopeID: "account-a", siteID: "site-a")
        try await h.store.signOut()
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == nil)
        #expect(await h.store.credential(accountScopeID: "account-a", siteID: "site-a") == nil)
        #expect(await h.files.persistedPayloadContains("key-a") == false)
    }

    @Test("First-time setup budgets discovery before explicitly selecting arrays")
    func discoveryThenExplicitArraySelection() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: [])
        let sites = try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        #expect(sites.map(\.resourceID) == ["east", "west"])
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 1)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .notConfigured)
        try await h.store.selectArrays(["east", "west"], accountScopeID: "account-a", siteID: "site-a")
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 3)
    }

    @Test("Discovery completion after disconnect is rejected")
    func disconnectRejectsLateDiscovery() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: [])
        await h.transport.holdResponses()
        let discovery = Task { try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a") }
        await h.transport.waitUntilRequestsStarted(1)
        try await h.store.disconnect(accountScopeID: "account-a", siteID: "site-a")
        await h.transport.resumeResponses()
        await #expect(throws: SolarForecastStore.StoreError.cancelled) { try await discovery.value }
        #expect(await h.store.credential(accountScopeID: "account-a", siteID: "site-a") == nil)
    }

    @Test("Discovery completion after switching account is rejected")
    func accountSwitchRejectsLateDiscovery() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: [])
        await h.transport.holdResponses()
        let discovery = Task { try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a") }
        await h.transport.waitUntilRequestsStarted(1)
        await h.store.activateAccountScope("account-b")
        await h.transport.resumeResponses()
        await #expect(throws: SolarForecastStore.StoreError.cancelled) { try await discovery.value }
    }

    @Test("Discovery plus manual refreshes cannot exceed ten total attempts")
    func manualRequestsStopAtTenIncludingDiscovery() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: [])
        _ = try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        try await h.store.selectArrays(["east"], accountScopeID: "account-a", siteID: "site-a")
        for _ in 0..<9 {
            #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .refreshed)
        }
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 10)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .budgetExhausted)
    }

    @Test("A reservation persistence failure marks retained cache unusable")
    func reservationPersistenceFailureDisablesCache() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        await h.files.failNextSave()
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.requestFailed))
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") != nil)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("A failed key replacement restores the matching prior credential after restart")
    func keyLabelMismatchAfterRestartRejectsRefresh() async throws {
        let h = Harness()
        let keyAID = try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.files.failNextSave()
        await #expect(throws: SolarForecastStore.StoreError.persistenceFailed) {
            _ = try await h.store.connect(apiKey: "key-b", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        }
        let restartedStore = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restartedStore.activateAccountScope("account-a")
        let restoredCredential = await restartedStore.credential(accountScopeID: "account-a", siteID: "site-a")
        #expect(restoredCredential?.credentialID == keyAID)
        #expect(!keyAID.isEmpty)
    }

    @Test("A failed live key replacement rolls back keychain and actor state")
    func failedConnectRollsBackLiveState() async throws {
        let h = Harness()
        let originalID = try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        let originalBatch = await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a")
        let originalBudget = await h.store.budget(for: "account-a", siteID: "site-a")
        await h.files.failNextSave()
        await #expect(throws: SolarForecastStore.StoreError.persistenceFailed) {
            _ = try await h.store.connect(apiKey: "key-b", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["west"])
        }
        #expect(await h.store.credential(accountScopeID: "account-a", siteID: "site-a")?.credentialID == originalID)
        let restoredKey = try await h.keychain.load(accountScopeID: "account-a", siteID: "site-a")
        #expect(restoredKey?.credentialID == originalID)
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == originalBatch)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a") == originalBudget)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
    }

    @Test("Failed keychain rollback leaves the live connection quarantined")
    func failedConnectRollbackQuarantinesScope() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.files.failNextSave()
        await h.keychain.failSaveAfter(successfulSaves: 1)
        await #expect(throws: SolarForecastStore.StoreError.cleanupFailed) {
            _ = try await h.store.connect(apiKey: "key-b", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["west"])
        }
        #expect(await h.store.credential(accountScopeID: "account-a", siteID: "site-a") == nil)
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == nil)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("Failed array selection persistence retains old selection and cache")
    func failedSelectionRollsBackLiveState() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        let oldBatch = await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a")
        await h.files.failNextSave()
        await #expect(throws: SolarForecastStore.StoreError.persistenceFailed) {
            try await h.store.selectArrays(["west"], accountScopeID: "account-a", siteID: "site-a")
        }
        #expect(await h.store.credential(accountScopeID: "account-a", siteID: "site-a")?.resourceIDs == ["east"])
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == oldBatch)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
    }

    @Test("Restaging the same key preserves selection and failed state")
    func restagingSameCredentialPreservesFailureAndSelection() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        await h.transport.failNext(1)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.requestFailed))
        _ = try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a")
        #expect(await h.store.credential(accountScopeID: "account-a", siteID: "site-a")?.resourceIDs == ["east"])
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("Discovery preserves typed unauthorized failure and disables retained cache")
    func discoveryUnauthorizedPreservesFailure() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        await h.transport.nextStatusCode(401)
        await #expect(throws: SolarForecastStore.StoreError.discoveryFailed(.unauthorized)) {
            try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        }
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
        #expect(await h.store.lastErrorDescription?.contains("key-a") == false)
    }

    @Test("Unauthorized discovery removes the rejected key across reopen")
    func unauthorizedDiscoveryDoesNotReopenConnected() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.transport.nextStatusCode(401)

        await #expect(throws: SolarForecastStore.StoreError.discoveryFailed(.unauthorized)) {
            try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        }

        #expect(await h.store.credential(accountScopeID: "account-a", siteID: "site-a") == nil)
        #expect(await h.keychain.count == 0)
        let reopened = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        #expect(await reopened.credential(accountScopeID: "account-a", siteID: "site-a") == nil)
    }

    @Test("Refresh cannot enter while key replacement persistence is held")
    func refreshIsBlockedDuringConnectMutation() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        let budgetBefore = await h.store.budget(for: "account-a", siteID: "site-a")
        await h.files.holdNextSave()
        let mutation = Task { try await h.store.connect(apiKey: "key-b", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["west"]) }
        await h.files.waitUntilSaveIsHeld()

        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .cancelled)
        #expect(await h.transport.requestCount == 0)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a") == budgetBefore)
        await h.files.resumeHeldSave()
        _ = try await mutation.value
    }

    @Test("Refresh cannot enter while same-credential selection persistence is held")
    func refreshIsBlockedDuringSelectionMutation() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        let budgetBefore = await h.store.budget(for: "account-a", siteID: "site-a")
        await h.files.holdNextSave()
        let mutation = Task { try await h.store.selectArrays(["west"], accountScopeID: "account-a", siteID: "site-a") }
        await h.files.waitUntilSaveIsHeld()

        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .cancelled)
        #expect(await h.transport.requestCount == 0)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a") == budgetBefore)
        await h.files.resumeHeldSave()
        try await mutation.value
    }

    @Test("Refresh cannot enter while disconnect keychain cleanup is held")
    func refreshIsBlockedDuringDisconnectMutation() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        let budgetBefore = await h.store.budget(for: "account-a", siteID: "site-a")
        await h.keychain.holdNextDelete()
        let mutation = Task { try await h.store.disconnect(accountScopeID: "account-a", siteID: "site-a") }
        await h.keychain.waitUntilDeleteIsHeld()

        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .cancelled)
        #expect(await h.transport.requestCount == 0)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a") == budgetBefore)
        await h.keychain.resumeHeldDelete()
        try await mutation.value
    }

    @Test("Discovery rate limit persists deferral and preserves typed failure")
    func discoveryRateLimitDefers() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: [])
        await h.transport.nextRateLimitDelay(600)
        await #expect(throws: SolarForecastStore.StoreError.discoveryFailed(.rateLimited)) {
            try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        }
        let count = await h.transport.requestCount
        await #expect(throws: SolarForecastStore.StoreError.deferred) {
            try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        }
        #expect(await h.transport.requestCount == count)
        h.clock.advance(by: 601)
        let discovered = try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        #expect(discovered.count == 2)
    }

    @Test("Discovery failure bookkeeping persistence errors are surfaced")
    func discoveryFailurePersistenceErrorIsSurfaced() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        await h.transport.nextStatusCode(401)
        await h.transport.holdResponses()
        let discovery = Task { try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true) }
        await h.transport.waitUntilRequestsStarted(1)
        await h.files.failNextSave()
        await h.transport.resumeResponses()
        await #expect(throws: SolarForecastStore.StoreError.persistenceFailed) { _ = try await discovery.value }
    }

    @Test("Discovery transport and invalid-response failures become safe typed failures")
    func discoveryTransportAndInvalidResponseFailures() async throws {
        let transportHarness = Harness()
        try await transportHarness.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: [])
        await transportHarness.transport.failNext(1)
        await #expect(throws: SolarForecastStore.StoreError.discoveryFailed(.requestFailed)) {
            try await transportHarness.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        }
        #expect(await transportHarness.store.lastErrorDescription == "Forecast network request failed")

        let invalidHarness = Harness()
        try await invalidHarness.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: [])
        await invalidHarness.transport.invalidNextDiscoveryResponse()
        await #expect(throws: SolarForecastStore.StoreError.discoveryFailed(.invalidForecast)) {
            try await invalidHarness.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        }
        #expect(await invalidHarness.store.lastErrorDescription == "Forecast response could not be used")
    }

    @Test("A 429 whose defer save fails quarantines the credential across restart")
    func failedRateLimitPersistenceQuarantinesAcrossRestart() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        await h.transport.nextRateLimitDelay(600)
        await h.files.failNextSaveAfter(successfulSaves: 1)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.storageFailure))
        #expect(await h.keychain.count == 0)

        let restarted = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restarted.activateAccountScope("account-a")
        #expect(await restarted.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == nil)
        #expect(await restarted.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .notConfigured)
        #expect(await restarted.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("A partial-array failure whose fallback save fails quarantines across restart")
    func failedPartialRefreshPersistenceQuarantinesAcrossRestart() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east", "west"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        await h.transport.failResourceID("west")
        await h.files.failNextSaveAfter(successfulSaves: 1)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.storageFailure))
        #expect(await h.keychain.count == 0)

        let restarted = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restarted.activateAccountScope("account-a")
        #expect(await restarted.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == nil)
        #expect(await restarted.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .notConfigured)
        #expect(await restarted.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("Refresh budget exhaustion disables retained cache across restart")
    func refreshBudgetExhaustionDisablesCache() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        for _ in 0..<SolarForecastStore.totalAttemptsPerUTCDay {
            #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .refreshed)
        }
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .budgetExhausted)

        let restarted = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restarted.activateAccountScope("account-a")
        #expect(await restarted.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("Automatic budget exhaustion disables a retained fresh cache across restart")
    func automaticBudgetExhaustionDisablesCache() async throws {
        let h = Harness(now: SolarForecastStoreTests.date("2026-09-27T01:00:00Z"))
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east", "west"])
        for attempt in 0..<(SolarForecastStore.automaticAttemptsPerUTCDay / 2) {
            if attempt > 0 { h.clock.advance(by: SolarForecastStore.foregroundRefreshThreshold + 1) }
            #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        }
        h.clock.advance(by: SolarForecastStore.foregroundRefreshThreshold + 1)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .budgetExhausted)

        let restarted = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restarted.activateAccountScope("account-a")
        #expect(await restarted.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("Discovery budget exhaustion disables retained cache across restart")
    func discoveryBudgetExhaustionDisablesCache() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        for _ in 0..<(SolarForecastStore.totalAttemptsPerUTCDay - 1) {
            _ = try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        }
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
        await #expect(throws: SolarForecastStore.StoreError.budgetExhausted) {
            try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        }

        let restarted = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restarted.activateAccountScope("account-a")
        #expect(await restarted.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("Composite account and site scopes cannot collide on delimiters")
    func compositeScopeIsCollisionSafe() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "acct|west", siteID: "home", resourceIDs: ["east"])
        try await h.store.connect(apiKey: "key-b", accountScopeID: "acct", siteID: "west|home", resourceIDs: ["east"])
        #expect(await h.store.credential(accountScopeID: "acct|west", siteID: "home")?.credentialID != nil)
        #expect(await h.store.credential(accountScopeID: "acct", siteID: "west|home")?.credentialID != nil)
        #expect(await h.store.credential(accountScopeID: "acct|west", siteID: "west|home") == nil)
    }

    @Test("Future-dated batches are not recommendation usable")
    func futureDatedBatchIsUnusable() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        await h.files.setFetchedAt(Self.date("2026-09-29T12:00:00Z"), accountScopeID: "account-a", siteID: "site-a")
        let restartedStore = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restartedStore.activateAccountScope("account-a")
        #expect(await restartedStore.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("Logout during a held refresh cannot restore its cache")
    @MainActor
    func logoutInvalidatesHeldRefresh() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.transport.holdResponses()
        let refresh = Task { await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") }
        await h.transport.waitUntilRequestsStarted(1)
        let auth = MobileAuthService(
            configuration: try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true),
            api: NoopMobileAuthAPI(),
            forecastCleanup: SolarForecastStoreSessionCleanup(store: h.store),
            initialAuthenticationState: true
        )
        try await auth.logout()
        await h.transport.resumeResponses()
        #expect(await refresh.value == .cancelled)
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == nil)
        #expect(await h.keychain.count == 0)
    }

    @Test("Sign-out reports persistence and keychain cleanup failures")
    func signOutReportsCleanupFailure() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.files.failNextSave()
        await h.keychain.failDeleteAll()
        await #expect(throws: SolarForecastStore.StoreError.cleanupFailed) { try await h.store.signOut() }
        #expect(await h.keychain.count == 1)
        #expect(await h.store.credential(accountScopeID: "account-a", siteID: "site-a") == nil)
    }

    static func date(_ value: String) -> Date {
        ISO8601DateFormatter().date(from: value)!
    }
}

private struct Harness: Sendable {
    let clock: TestClock
    let transport: TestSolcastTransport
    let keychain: TestCredentialKeychain
    let files: TestSolarForecastFiles
    let store: SolarForecastStore

    init(now: Date = SolarForecastStoreTests.date("2026-09-27T12:00:00Z")) {
        clock = TestClock(now: now)
        transport = TestSolcastTransport()
        keychain = TestCredentialKeychain()
        files = TestSolarForecastFiles()
        store = SolarForecastStore(clock: clock, keychain: keychain, files: files, transport: transport)
    }
}

private final class TestClock: SolarForecastClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    init(now: Date) { current = now }
    func now() -> Date { lock.lock(); defer { lock.unlock() }; return current }
    func advance(by seconds: TimeInterval) { lock.lock(); current.addTimeInterval(seconds); lock.unlock() }
}

private actor TestCredentialKeychain: SolcastCredentialKeychain {
    private var values: [String: SolcastStoredCredential] = [:]
    private var shouldFailDeleteAll = false
    private var successfulSavesBeforeFailure: Int?
    private var shouldHoldNextDelete = false
    private var heldDelete: CheckedContinuation<Void, Never>?
    var count: Int { values.count }
    func save(key: String, accountScopeID: String, siteID: String, credentialID: String) async throws {
        if let remaining = successfulSavesBeforeFailure {
            if remaining == 0 { successfulSavesBeforeFailure = nil; throw TestFileError.failedWrite }
            successfulSavesBeforeFailure = remaining - 1
        }
        values[SolarForecastScope.key(accountScopeID, siteID)] = SolcastStoredCredential(key: key, credentialID: credentialID)
    }
    func load(accountScopeID: String, siteID: String) async throws -> SolcastStoredCredential? { values[SolarForecastScope.key(accountScopeID, siteID)] }
    func delete(accountScopeID: String, siteID: String) async throws {
        if shouldHoldNextDelete {
            shouldHoldNextDelete = false
            await withCheckedContinuation { heldDelete = $0 }
        }
        values.removeValue(forKey: SolarForecastScope.key(accountScopeID, siteID))
    }
    func deleteAll(accountScopeID: String) async throws { values = values.filter { !$0.key.hasPrefix(SolarForecastScope.prefix(accountScopeID)) } }
    func deleteAllCredentials() async throws {
        if shouldFailDeleteAll { shouldFailDeleteAll = false; throw TestFileError.failedWrite }
        values.removeAll()
    }
    func failDeleteAll() { shouldFailDeleteAll = true }
    func failSaveAfter(successfulSaves: Int) { successfulSavesBeforeFailure = successfulSaves }
    func holdNextDelete() { shouldHoldNextDelete = true }
    func waitUntilDeleteIsHeld() async { while heldDelete == nil { await Task.yield() } }
    func resumeHeldDelete() { heldDelete?.resume(); heldDelete = nil }
}

private actor TestSolarForecastFiles: SolarForecastPersistence {
    private var state = SolarForecastPersistedState()
    private var payload = Data()
    private var shouldFailNextSave = false
    private var successfulSavesBeforeFailure: Int?
    private var shouldHoldNextSave = false
    private var heldSave: CheckedContinuation<Void, Never>?
    func loadState() async throws -> SolarForecastPersistedState { state }
    func saveState(_ newState: SolarForecastPersistedState) async throws {
        if shouldHoldNextSave {
            shouldHoldNextSave = false
            await withCheckedContinuation { heldSave = $0 }
        }
        if let remaining = successfulSavesBeforeFailure {
            if remaining == 0 { successfulSavesBeforeFailure = nil; throw TestFileError.failedWrite }
            successfulSavesBeforeFailure = remaining - 1
        }
        if shouldFailNextSave { shouldFailNextSave = false; throw TestFileError.failedWrite }
        state = newState
        payload = (try? JSONEncoder().encode(newState)) ?? Data()
    }
    func failNextSave() { shouldFailNextSave = true }
    func failNextSaveAfter(successfulSaves: Int) { successfulSavesBeforeFailure = successfulSaves }
    func holdNextSave() { shouldHoldNextSave = true }
    func waitUntilSaveIsHeld() async { while heldSave == nil { await Task.yield() } }
    func resumeHeldSave() { heldSave?.resume(); heldSave = nil }
    func setFetchedAt(_ date: Date, accountScopeID: String, siteID: String) {
        let key = SolarForecastScope.key(accountScopeID, siteID)
        guard let batch = state.caches[key] else { return }
        state.caches[key] = SolarForecastBatch(credentialID: batch.credentialID, resourceIDs: batch.resourceIDs, intervals: batch.intervals, fetchedAt: date)
    }
    func persistedPayloadContains(_ value: String) -> Bool { String(decoding: payload, as: UTF8.self).contains(value) }
}

private enum TestFileError: Error { case failedWrite }

@MainActor
private struct NoopMobileAuthAPI: MobileAuthAPI {
    func exchangeSession(_ exchange: MobileSessionExchange) async throws {}
    func logout() async throws {}
    func clearSiteAuthCookie() async {}
}

private actor TestSolcastTransport: SolcastTransport {
    private(set) var requestCount = 0
    private var hold = false
    private var failures = 0
    private var statusCode: Int?
    private var rateLimitDelay: TimeInterval?
    private var failedID: String?
    private var invalidDiscoveryResponse = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func holdResponses() { hold = true }
    func failNext(_ count: Int) { failures = count }
    func nextStatusCode(_ value: Int) { statusCode = value }
    func nextRateLimitDelay(_ value: TimeInterval) { rateLimitDelay = value }
    func failResourceID(_ value: String) { failedID = value }
    func invalidNextDiscoveryResponse() { invalidDiscoveryResponse = true }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requestCount += 1
        if hold { await withCheckedContinuation { waiters.append($0) } }
        if failures > 0 { failures -= 1; throw URLError(.timedOut) }
        let resourceID = request.url?.pathComponents.last(where: { $0 != "forecasts" })
        let status = resourceID == failedID ? 500 : (statusCode ?? (rateLimitDelay == nil ? 200 : 429))
        statusCode = nil
        var headers: [String: String] = [:]
        if let delay = rateLimitDelay { headers["Retry-After"] = String(Int(delay)); rateLimitDelay = nil }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        let body = request.url?.path == "/rooftop_sites"
            ? (invalidDiscoveryResponse ? "{}" : #"{"sites":[{"resource_id":"east","name":"East","tags":[]},{"resource_id":"west","name":"West","tags":[]}] }"#)
            : #"{"forecasts":[{"period_end":"2026-09-27T13:00:00Z","period":"PT30M","pv_estimate":2.0}] }"#
        invalidDiscoveryResponse = false
        return (Data(body.utf8), response)
    }

    func waitUntilRequestsStarted(_ count: Int) async {
        while requestCount < count { await Task.yield() }
    }
    func resumeResponses() { hold = false; let pending = waiters; waiters.removeAll(); pending.forEach { $0.resume() } }
}
