import Foundation
@testable import PWUsage
import Testing

@Suite("Solar Forecast Store Tests", .serialized)
struct SolarForecastStoreTests {
    @Test("Concurrent refreshes share one complete request batch")
    func concurrentRefreshesShareOneBatch() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east", "west"])
        await h.transport.holdResponses()
        async let first = h.store.refresh(accountScopeID: "account-a", siteID: "site-a")
        try await h.transport.waitUntilRequestsStarted(1)
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
        try await h.transport.waitUntilRequestsStarted(1)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 2)
        await h.transport.resumeResponses()
        #expect(await refresh.value == .refreshed)
    }

    @Test("Failures consume the persisted budget and retries cannot exceed the automatic cap")
    func failuresConsumeBudget() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        await h.transport.failNext(3)
        for _ in 0 ..< 3 { _ = await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") }
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 3)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").automaticAttempts == 3)
    }

    @Test("A cancelled refresh is not a network failure and is not charged")
    func cancelledRefreshLeavesBudgetUnchanged() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        let before = await h.store.budget(for: "account-a", siteID: "site-a")
        await h.transport.cancelNext()

        let result = await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true)

        #expect(result == .cancelled)
        #expect(await h.transport.requestCount == 1)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a") == before)
        #expect(await h.store.lastErrorDescription == nil)
        // The refund reaches disk, so a relaunch does not count the cancelled attempt either.
        let saved = try await h.files.loadState()
        #expect(saved.budgets.values.allSatisfy { $0.totalAttempts == before.totalAttempts })
        // The next refresh is a normal one.
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .refreshed)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == before.totalAttempts + 1)
    }

    @Test("A cancelled two-array refresh is charged only for the request that completed")
    func cancelledSecondArrayRefundsOnlyUnfinishedRequest() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east", "west"])
        let before = await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts
        await h.transport.cancelRequest(number: 2)

        let result = await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true)

        #expect(result == .cancelled)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == before + 1)
    }

    @Test("A refresh invalidated while its budget save is held is not charged")
    func refreshInvalidatedBeforeDispatchIsRefunded() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        let before = await h.store.budget(for: "account-a", siteID: "site-a")
        await h.files.holdNextSave()
        let refresh = Task { await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) }
        try await h.files.waitUntilSaveIsHeld()
        try await h.store.selectArrays(["west"], accountScopeID: "account-a", siteID: "site-a")
        await h.files.resumeHeldSave()

        #expect(await refresh.value == .cancelled)
        #expect(await h.transport.requestCount == 0)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a") == before)
        let saved = try await h.files.loadState()
        #expect(saved.budgets.values.allSatisfy { $0.totalAttempts == before.totalAttempts })
    }

    @Test("A discovery invalidated while its budget save is held is not charged")
    func discoveryInvalidatedBeforeDispatchIsRefunded() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        let before = await h.store.budget(for: "account-a", siteID: "site-a")
        await h.files.holdNextSave()
        let discovery = Task { try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true) }
        try await h.files.waitUntilSaveIsHeld()
        try await h.store.selectArrays(["west"], accountScopeID: "account-a", siteID: "site-a")
        await h.files.resumeHeldSave()

        await #expect(throws: SolarForecastStore.StoreError.cancelled) { _ = try await discovery.value }
        #expect(await h.transport.requestCount == 0)
        #expect(await h.store.budget(for: "account-a", siteID: "site-a") == before)
    }

    @Test("A cancelled discovery is not charged")
    func cancelledDiscoveryLeavesBudgetUnchanged() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "synthetic-key", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        let before = await h.store.budget(for: "account-a", siteID: "site-a")
        await h.transport.cancelNext()

        await #expect(throws: SolarForecastStore.StoreError.cancelled) {
            _ = try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        }
        #expect(await h.store.budget(for: "account-a", siteID: "site-a") == before)
        #expect(await h.store.lastErrorDescription == nil)
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
        for _ in 0 ..< 4 {
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
        try await h.transport.waitUntilRequestsStarted(1)
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
        try await h.transport.waitUntilRequestsStarted(1)
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
        // A failed request doesn't dismiss the forecast already saved.
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
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
        try await h.transport.waitUntilRequestsStarted(1)

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
        try await h.transport.waitUntilRequestsStarted(1)

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
        #expect(await h.keychain.isEmpty)
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
        try await h.transport.waitUntilRequestsStarted(1)
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
        try await h.transport.waitUntilRequestsStarted(1)
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
        for _ in 0 ..< 9 {
            #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .refreshed)
        }
        #expect(await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts == 10)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .budgetExhausted)
    }

    /// This test used to assert the opposite of the last line, and used to expect
    /// `.failed(.requestFailed)`. Both were wrong, not merely outdated. The write
    /// failure is a save failure, and marking the scope failed hid a good forecast —
    /// see the comment on the budget save in `performRefresh` for why the marking
    /// delivered none of the protection it was justified by.
    @Test("A reservation persistence failure keeps the retained cache usable")
    func reservationPersistenceFailureKeepsCacheUsable() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        await h.files.failNextSave()
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.saveFailed))
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") != nil)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
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
        // A failure that disables the forecast (the array is unknown to Solcast).
        await h.transport.nextStatusCode(404)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.unknownResource))
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
        #expect(await h.keychain.isEmpty)
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
        try await h.files.waitUntilSaveIsHeld()

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
        try await h.files.waitUntilSaveIsHeld()

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
        try await h.keychain.waitUntilDeleteIsHeld()

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
        try await h.transport.waitUntilRequestsStarted(1)
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
        let managed: any SolarForecastManaging = transportHarness.store
        #expect(await managed.lastErrorDescription == "Forecast network request failed",
                "The store's own description must back the protocol, not the extension's nil.")

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
        #expect(await h.keychain.isEmpty)

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
        #expect(await h.keychain.isEmpty)

        let restarted = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restarted.activateAccountScope("account-a")
        #expect(await restarted.cachedBatch(accountScopeID: "account-a", siteID: "site-a") == nil)
        #expect(await restarted.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .notConfigured)
        #expect(await restarted.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("A write left pending by a save failure is retried on the next refresh")
    func pendingWriteIsRetriedOnTheNextRefresh() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        let firstFetch = h.clock.now()
        h.clock.advance(by: 1800)

        // One save is let through so the post-fetch write is the one that fails.
        await h.files.failNextSaveAfter(successfulSaves: 1)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.saveFailed))
        let secondFetch = h.clock.now()

        // The batch is still fresh in memory, so the .alreadyFresh short-circuit is
        // the one that runs here. It has to attempt the write before reporting the
        // cache fresh, or the note's promise to retry is kept by nothing.
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)

        // Asserted on the stamp, not on existence: a stale batch from the first
        // refresh is still on disk either way, so merely finding a cache after a
        // restart would pass against the unfixed code and prove nothing. The retry
        // is what makes the *newer* batch the one that survives.
        let restarted = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restarted.activateAccountScope("account-a")
        #expect(await restarted.cachedBatch(accountScopeID: "account-a", siteID: "site-a")?.fetchedAt == secondFetch)
        #expect(secondFetch > firstFetch)
    }

    @Test("A write that keeps failing is reported as a save failure, not as a fresh cache")
    func persistentlyFailingWriteKeepsReportingSaveFailure() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)

        // Budget save let through, then the post-fetch write fails, then the retry on
        // the next refresh fails too. Reporting .alreadyFresh while the write is
        // still outstanding would clear the note the user needs.
        await h.files.failSaves(2, afterSuccessfulSaves: 1)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.saveFailed))
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .failed(.saveFailed))
        // The retry must not become a new route to quarantine.
        #expect(await h.keychain.count == 1)
    }

    @Test("A budget-save failure is reported as a save failure, not a network failure")
    func budgetSaveFailureIsNotReportedAsARequestFailure() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)

        // One save is let through so the pre-fetch budget write is the one that
        // fails. Reported as `.requestFailed` this read as "Solcast could not be
        // reached. Retry when you have a connection" -- a network remedy for a
        // full disk -- and `SolarForecastUnavailableCause` mapped it to a cause,
        // so the card said "Solar forecast unavailable".
        await h.files.failNextSaveAfter(successfulSaves: 0)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.saveFailed))
        #expect(SolarForecastUnavailableCause(SolarForecastRefreshResult.failed(.saveFailed)) == nil)
        #expect(SolarForecastUnavailableCause(SolarForecastRefreshResult.failed(.requestFailed)) != nil)
    }

    @Test("A budget-save failure leaves the request counter to be written on the next refresh")
    func budgetSaveFailureRetriesTheCounterWrite() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)

        // The reservation was made in memory and the write failed, so memory and
        // disk now disagree and nothing records that a write is still owed. The
        // cache is still fresh, so the next refresh takes the .alreadyFresh path,
        // which reaches neither budget save; without dirtyScopes the divergence
        // would sit there for the whole freshness window.
        //
        // Note what the pending write carries. The reservation is made before the
        // fetch, and this attempt returns without fetching, so it charges for a
        // request that never happened. Joining dirtyScopes does not avoid that
        // phantom -- the first real fetch at the end of the window persists the
        // same in-memory counter -- it only decides *when* memory and disk
        // converge rather than leaving them apart. The alternative leaves them
        // divergent and reaches the same over-count later.
        await h.files.failNextSaveAfter(successfulSaves: 0)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.saveFailed))
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)

        let attemptsBefore = await h.store.budget(for: "account-a", siteID: "site-a").totalAttempts
        let restarted = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restarted.activateAccountScope("account-a")
        #expect(await restarted.budget(for: "account-a", siteID: "site-a").totalAttempts == attemptsBefore)
    }

    @Test("A save failure on the budget reservation never quarantines the credential")
    func budgetReservationSaveFailureNeverQuarantines() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)

        // Two consecutive write failures with nothing allowed through first, so
        // the FIRST save performRefresh makes — the pre-fetch budget reservation —
        // is the one that fails. Escalating that to persistFailureState would then
        // hit its own failing write and delete a credential that was just proven
        // to work: the request never even reached Solcast. The result is a save
        // failure, not a request failure -- see the budget save in performRefresh.
        await h.files.failSaves(2, afterSuccessfulSaves: 0)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.saveFailed))
        #expect(await h.keychain.count == 1)
    }

    @Test("A save failure on the discovery budget never destroys a just-typed key")
    func discoveryBudgetSaveFailureKeepsJustTypedKey() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: [])

        // Same two consecutive failures, aimed at the budget save in
        // discoverSites. This is the first-run path — saveKeyAndDiscover connects
        // and discovers back to back — so the key at risk is the one the user has
        // just typed and has no other copy of. Nothing has been fetched yet, so
        // there is no evidence against the credential at all.
        await h.files.failSaves(2, afterSuccessfulSaves: 0)
        await #expect(throws: SolarForecastStore.StoreError.persistenceFailed) {
            try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a")
        }
        #expect(await h.keychain.count == 1)
    }

    @Test("A save failure after a successful fetch never quarantines the credential")
    func saveFailureAfterSuccessfulFetchNeverQuarantines() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)

        // Two consecutive save failures: the post-fetch write, then the fallback
        // write that persistFailureState attempts. That pair is the exact shape
        // that used to reach quarantineCredential and delete the key. The budget
        // save performRefresh makes before fetching is let through.
        await h.files.failSaves(2, afterSuccessfulSaves: 1)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.saveFailed))
        #expect(await h.keychain.count == 1)
        #expect(await h.store.cachedBatch(accountScopeID: "account-a", siteID: "site-a") != nil)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
    }

    @Test("Refresh budget exhaustion keeps a retained fresh cache usable across restart")
    func refreshBudgetExhaustionDisablesCache() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        for _ in 0 ..< SolarForecastStore.totalAttemptsPerUTCDay {
            #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .refreshed)
        }
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .budgetExhausted)

        let restarted = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restarted.activateAccountScope("account-a")
        #expect(await restarted.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
    }

    @Test("Automatic budget exhaustion keeps a retained fresh cache usable across restart")
    func automaticBudgetExhaustionDisablesCache() async throws {
        let h = Harness(now: SolarForecastStoreTests.date("2026-09-27T01:00:00Z"))
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east", "west"])
        for attempt in 0 ..< (SolarForecastStore.automaticAttemptsPerUTCDay / 2) {
            if attempt > 0 { h.clock.advance(by: SolarForecastStore.foregroundRefreshThreshold + 1) }
            #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        }
        h.clock.advance(by: SolarForecastStore.foregroundRefreshThreshold + 1)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .budgetExhausted)

        let restarted = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restarted.activateAccountScope("account-a")
        #expect(await restarted.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
    }

    @Test("Discovery budget exhaustion keeps a retained fresh cache usable across restart")
    func discoveryBudgetExhaustionDisablesCache() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        for _ in 0 ..< (SolarForecastStore.totalAttemptsPerUTCDay - 1) {
            _ = try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        }
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
        await #expect(throws: SolarForecastStore.StoreError.budgetExhausted) {
            try await h.store.discoverSites(accountScopeID: "account-a", siteID: "site-a", manual: true)
        }

        let restarted = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restarted.activateAccountScope("account-a")
        #expect(await restarted.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
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
        try await h.transport.waitUntilRequestsStarted(1)
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
        #expect(await h.keychain.isEmpty)
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

    // MARK: A current forecast is not dismissed over a refused or failed request

    @Test("A rate-limited refresh keeps the fresh cached forecast usable")
    func rateLimitKeepsFreshCache() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        await h.transport.nextStatusCode(429)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.rateLimited))
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
    }

    @Test("A network failure keeps the fresh cached forecast usable")
    func networkFailureKeepsFreshCache() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        await h.transport.failNext(1)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.requestFailed))
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
    }

    @Test("Budget exhaustion keeps the fresh cached forecast usable, across restart")
    func budgetExhaustionKeepsFreshCache() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        for _ in 0 ..< SolarForecastStore.totalAttemptsPerUTCDay {
            #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .refreshed)
        }
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .budgetExhausted)
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))

        let restarted = SolarForecastStore(clock: h.clock, keychain: h.keychain, files: h.files, transport: h.transport)
        await restarted.activateAccountScope("account-a")
        #expect(await restarted.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a"))
        // It still ages out like any forecast.
        h.clock.advance(by: SolarForecastStore.recommendationFreshness + 1)
        #expect(await restarted.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
    }

    @Test("An array Solcast no longer knows still disables the cached forecast")
    func unknownArrayStillDisablesCache() async throws {
        let h = Harness()
        try await h.store.connect(apiKey: "key-a", accountScopeID: "account-a", siteID: "site-a", resourceIDs: ["east"])
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a") == .refreshed)
        await h.transport.nextStatusCode(404)
        #expect(await h.store.refresh(accountScopeID: "account-a", siteID: "site-a", manual: true) == .failed(.unknownResource))
        #expect(await h.store.isRecommendationUsable(accountScopeID: "account-a", siteID: "site-a") == false)
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
    func deleteAllCredentials() async throws {
        if shouldFailDeleteAll { shouldFailDeleteAll = false; throw TestFileError.failedWrite }
        values.removeAll()
    }
    func failDeleteAll() { shouldFailDeleteAll = true }
    func failSaveAfter(successfulSaves: Int) { successfulSavesBeforeFailure = successfulSaves }
    func holdNextDelete() { shouldHoldNextDelete = true }
    func waitUntilDeleteIsHeld() async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(2))
        while heldDelete == nil {
            guard clock.now < deadline else {
                throw TestWaitTimeout(message: "Timed out waiting for delete to be held")
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
    func resumeHeldDelete() { heldDelete?.resume(); heldDelete = nil }
}

private actor TestSolarForecastFiles: SolarForecastPersistence {
    private var state = SolarForecastPersistedState()
    private var payload = Data()
    private var shouldFailNextSave = false
    private var successfulSavesBeforeFailure: Int?
    private var consecutiveSavesToFail = 0
    private var successfulSavesBeforeConsecutiveFailure = 0
    private var shouldHoldNextSave = false
    private var heldSave: CheckedContinuation<Void, Never>?
    func loadState() async throws -> SolarForecastPersistedState { state }
    func saveState(_ newState: SolarForecastPersistedState) async throws {
        if shouldHoldNextSave {
            shouldHoldNextSave = false
            await withCheckedContinuation { heldSave = $0 }
        }
        if successfulSavesBeforeConsecutiveFailure > 0 {
            successfulSavesBeforeConsecutiveFailure -= 1
        } else if consecutiveSavesToFail > 0 {
            consecutiveSavesToFail -= 1
            throw TestFileError.failedWrite
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
    /// Fails `count` saves in a row. `afterSuccessfulSaves` lets those through
    /// first, so the run of failures can start at a chosen point in a refresh —
    /// `performRefresh` saves once for the request budget before it fetches, so
    /// a test targeting the post-fetch write has to allow that one save through.
    func failSaves(_ count: Int, afterSuccessfulSaves: Int = 0) {
        consecutiveSavesToFail = count
        successfulSavesBeforeConsecutiveFailure = afterSuccessfulSaves
    }
    func holdNextSave() { shouldHoldNextSave = true }
    func waitUntilSaveIsHeld() async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(2))
        while heldSave == nil {
            guard clock.now < deadline else {
                throw TestWaitTimeout(message: "Timed out waiting for save to be held")
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
    func resumeHeldSave() { heldSave?.resume(); heldSave = nil }
    func setFetchedAt(_ date: Date, accountScopeID: String, siteID: String) {
        let key = SolarForecastScope.key(accountScopeID, siteID)
        guard let batch = state.caches[key] else { return }
        state.caches[key] = SolarForecastBatch(credentialID: batch.credentialID, resourceIDs: batch.resourceIDs, intervals: batch.intervals, fetchedAt: date)
    }
    func persistedPayloadContains(_ value: String) -> Bool { (String(bytes: payload, encoding: .utf8) ?? "").contains(value) }
}

private enum TestFileError: Error { case failedWrite }

private struct TestWaitTimeout: Error { let message: String }

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
    private var cancelledRequest: Int?
    private var statusCode: Int?
    private var rateLimitDelay: TimeInterval?
    private var failedID: String?
    private var invalidDiscoveryResponse = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func holdResponses() { hold = true }
    func failNext(_ count: Int) { failures = count }
    func cancelNext() { cancelledRequest = requestCount + 1 }
    func cancelRequest(number: Int) { cancelledRequest = number }
    func nextStatusCode(_ value: Int) { statusCode = value }
    func nextRateLimitDelay(_ value: TimeInterval) { rateLimitDelay = value }
    func failResourceID(_ value: String) { failedID = value }
    func invalidNextDiscoveryResponse() { invalidDiscoveryResponse = true }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requestCount += 1
        if hold { await withCheckedContinuation { waiters.append($0) } }
        if failures > 0 { failures -= 1; throw URLError(.timedOut) }
        if requestCount == cancelledRequest { cancelledRequest = nil; throw URLError(.cancelled) }
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

    func waitUntilRequestsStarted(_ count: Int) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(2))
        while requestCount < count {
            guard clock.now < deadline else {
                throw TestWaitTimeout(message: "Timed out waiting for \(count) requests to start")
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
    func resumeResponses() { hold = false; let pending = waiters; waiters.removeAll(); pending.forEach { $0.resume() } }
}
