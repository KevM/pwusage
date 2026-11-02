import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Automatic solar forecast coordinator")
struct AutomaticForecastCoordinatorTests {
    @Test("Without Solcast, a detected layout publishes the automatic forecast")
    func detectedLayoutPublishes() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastState == .enhanced)
        #expect(harness.coordinator.solarForecastSource == .openMeteo)
        let intervals = try #require(harness.coordinator.publishedForecastIntervals)
        #expect(intervals.allSatisfy { $0.powerKw == 2 })
        #expect(harness.coordinator.solarForecastAttribution == "Forecast by Open-Meteo.")
        #expect(harness.coordinator.solarLayoutStatus == AutomaticForecastHarness.detectedResponse)
    }

    @Test("A persisted sync result overrides stale in-memory beta eligibility", arguments: [true, false])
    func persistedEligibilityWins(persistedEnabled: Bool) async throws {
        let harness = await AutomaticForecastHarness()
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
        harness.api.historyResponse = persistedEnabled
            ? .enabled(timeZone: .gmt, days: [], nextFrom: nil) : .disabled
        _ = try await harness.historyStore.sync(scope: scope, api: harness.api, now: harness.api.now)
        harness.coordinator.historyEnabled = !persistedEnabled
        let fetches = harness.api.historyFetches.count

        await harness.coordinator.loadTimingDetailAppeared()

        #expect(harness.api.historyFetches.count == fetches)
        #expect(harness.coordinator.historyEnabled == persistedEnabled)
        #expect((harness.coordinator.solarLayoutStatus == .disabled) == !persistedEnabled)
        #expect((harness.coordinator.solarForecastSource == .openMeteo) == persistedEnabled)
    }

    @Test("Outside the beta: no actuals, no automatic refresh, basic estimate")
    func disabled() async throws {
        let harness = await AutomaticForecastHarness()
        harness.coordinator.historyEnabled = false
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastState == .basic)
        #expect(harness.coordinator.solarForecastSource == nil)
        #expect(harness.coordinator.householdPattern != nil)
        #expect(await harness.automatic.refreshes == 0)
    }

    @Test("Low confidence keeps the basic estimate and exposes the reason")
    func lowConfidence() async throws {
        let harness = await AutomaticForecastHarness()
        try await harness.setLowConfidence()
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastState == .basic)
        guard case .enabled(_, _, let reason) = harness.coordinator.solarLayoutStatus else {
            Issue.record("Expected enabled status")
            return
        }
        #expect(reason == .lowConfidence)
        #expect(await harness.automatic.refreshes == 0)
    }

    @Test("Correction scales the automatic forecast; failed actuals leave it raw")
    func correction() async throws {
        let harness = await AutomaticForecastHarness()
        try await harness.seedCorrection(ratio: 0.8, providerID: .openMeteo, fingerprint: "stub")
        await harness.coordinator.loadTimingDetailAppeared()
        let corrected = try #require(harness.coordinator.publishedForecastIntervals)
        #expect(corrected.allSatisfy { abs($0.powerKw - 1.6) < 1e-9 })

        let failing = await AutomaticForecastHarness()
        await failing.coordinator.loadTimingDetailAppeared()
        #expect(failing.coordinator.publishedForecastIntervals?.allSatisfy { $0.powerKw == 2 } == true)
    }

    @Test("A suspended site A response is dropped after switching to site B")
    func siteSwitchDropsOldResponse() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.automatic.setHold(true)
        let pending = Task { await harness.coordinator.loadTimingDetailAppeared() }
        try await eventually { harness.coordinator.forecastOperationPending }
        harness.coordinator.selectSite("site-b")
        await harness.automatic.resume()
        await pending.value
        #expect(harness.coordinator.solarForecastSource == nil)
        #expect(harness.coordinator.publishedForecastIntervals == nil)
        #expect(harness.coordinator.solarLayoutStatus == nil)
    }

    @Test("Diagnostics name the provider, revision, age, coverage and factors without secrets")
    func diagnostics() async throws {
        let harness = await AutomaticForecastHarness()
        try await harness.seedCorrection(ratio: 0.8, providerID: .openMeteo, fingerprint: "stub")
        await harness.coordinator.loadTimingDetailAppeared()
        let diagnostics = try #require(await harness.coordinator.solarForecastDiagnostics())
        let source = try #require(diagnostics.source)
        #expect(source.providerID == "open-meteo")
        #expect(source.configurationRevision == "stub")
        #expect(source.ageMinutes == 0)
        #expect(source.coverageEnd > source.coverageStart)
        #expect(source.sameDaySamples > 0)
        #expect(source.dayAheadFactors.values.allSatisfy { abs($0 - 0.8) < 1e-9 })
    }
}

extension AutomaticForecastCoordinatorTests {
    @Test("Automatic provider failures remain available to diagnostics")
    func failedAutomaticAttemptIsDiagnosable() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.automatic.setFailing(true)
        await harness.coordinator.loadTimingDetailAppeared()
        let diagnostics = try #require(await harness.coordinator.solarForecastDiagnostics())
        #expect(diagnostics.automaticProviderID == "open-meteo")
        #expect(diagnostics.automaticRefreshOutcome != nil)
        #expect(harness.coordinator.solarForecastUnavailableReason == .forecastNotUsable)
        #expect(harness.coordinator.publishedForecastIntervals == nil)
    }

    @Test("Pull to refresh bypasses cached disabled status to pick up beta enrollment")
    func pullToRefreshRechecksDisabledBetaEnrollment() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        try await harness.setNeedsLocation()
        harness.api.historyResponse = .disabled

        // Cold start learns disabled
        await harness.coordinator.refreshSolarForecast(manual: false)
        #expect(harness.coordinator.solarLayoutStatus == .disabled)
        #expect(!harness.coordinator.historyEnabled)

        // Subsequent lookup within 24h stays on cached disabled without network
        let initialFetches = harness.api.historyFetches.count
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.api.historyFetches.count == initialFetches)
        #expect(harness.coordinator.solarLayoutStatus == .disabled)

        // Admin grants beta, user pulls to refresh
        harness.api.historyResponse = .enabled(timeZone: .gmt, days: [], nextFrom: nil)
        harness.coordinator.invalidateSolarLayout()
        await harness.coordinator.refreshSolarForecast(manual: true)

        #expect(harness.api.historyFetches.count > initialFetches)
        #expect(harness.coordinator.historyEnabled)
        guard case .enabled(_, _, let reason) = harness.coordinator.solarLayoutStatus else {
            Issue.record("Expected enabled status after pull to refresh")
            return
        }
        #expect(reason == .needsLocation)
    }

    @Test("Site switch during history sync drops old lookup and does not disable beta on new site")
    func siteSwitchDuringHistorySyncDoesNotDisableBetaOnNewSite() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        harness.api.holdHistory = true
        let pending = Task { await harness.coordinator.loadTimingDetailAppeared() }
        try await eventually { harness.api.historyFetches.count == 1 }
        harness.coordinator.selectSite("site-b")
        harness.api.historyError = PWUsageAPIError.invalidResponse
        harness.api.resumeHistory()
        await pending.value
        #expect(harness.coordinator.historyEnabled)
        #expect(harness.coordinator.solarLayoutStatus == nil)
    }

    @Test("Offline history recheck with cached layout record preserves disabled beta status")
    func offlineHistoryRecheckWithCachedRecordPreservesDisabledStatus() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        harness.api.historyResponse = .disabled
        await harness.coordinator.refreshSolarForecast(manual: false)
        #expect(harness.coordinator.solarLayoutStatus == .disabled)

        try await harness.setNeedsLocation()
        harness.coordinator.historyEnabled = true
        harness.coordinator.invalidateSolarLayout()
        harness.api.historyError = PWUsageAPIError.invalidResponse
        await harness.coordinator.refreshSolarForecast(manual: true)

        #expect(!harness.coordinator.historyEnabled)
        #expect(harness.coordinator.solarLayoutStatus == .disabled)
    }

    @Test("Superseded lookup operation does not consume layout invalidation flag")
    func supersededLookupDoesNotConsumeInvalidationFlag() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        harness.coordinator.invalidateSolarLayout()
        let staleResponse = await harness.coordinator.solarLayoutLookup(
            siteID: "site-1",
            operation: harness.coordinator.forecastGeneration - 1
        )
        #expect(staleResponse == nil)
        #expect(harness.coordinator.layoutInvalidated)
    }

    @Test("Restoring beta eligibility with a pending location starts due detection")
    func restoringEligibilityStartsDueDetection() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        try await harness.setPending()
        harness.api.historyResponse = .disabled
        let scope = SolarForecastSiteScope(accountScopeID: "account-a", siteID: "site-a")
        _ = try await harness.historyStore.sync(scope: scope, api: harness.api, now: harness.api.now)

        await harness.coordinator.refreshSolarForecast(manual: false)
        #expect(harness.coordinator.solarLayoutStatus == .disabled)
        #expect(!harness.coordinator.historyEnabled)

        harness.api.historyResponse = .enabled(timeZone: .gmt, days: [], nextFrom: nil)
        harness.coordinator.invalidateSolarLayout()
        await harness.coordinator.refreshSolarForecast(manual: true)

        try await eventually {
            harness.coordinator.solarLayoutStatus == AutomaticForecastHarness.detectedResponse
                && harness.coordinator.solarForecastSource == .openMeteo
        }
    }
}
