import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Automatic solar forecast in the dashboard coordinator")
struct AutomaticForecastCoordinatorTests {
    private static let credential = SolarForecastCredential(
        accountScopeID: "account-a", siteID: "site-a", credentialID: "cred", resourceIDs: ["r1"]
    )

    private static func solcastBatch(now: Date) -> SolarForecastBatch {
        SolarForecastBatch(
            credentialID: "cred", resourceIDs: ["r1"],
            intervals: SolarProviderFixture.intervals(from: now.addingTimeInterval(-3600), hours: 72, powerKw: 3),
            fetchedAt: now
        )
    }

    @Test("Without Solcast, a detected layout publishes the automatic forecast")
    func automaticPublished() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        let coordinator = harness.coordinator
        #expect(coordinator.solarForecastState == .enhanced)
        #expect(coordinator.solarForecastSource == .forecastSolar)
        #expect(coordinator.solarForecastConnection == .notConnected)
        #expect(coordinator.forecastConnectionForConsumers == .ready)
        let intervals = try #require(coordinator.publishedForecastIntervals)
        #expect(intervals.allSatisfy { $0.powerKw == 2 })
        #expect(coordinator.solarForecastAttribution == "Forecast by Forecast.Solar.")
        #expect(coordinator.solarLayoutStatus == AutomaticForecastHarness.detectedResponse)
    }

    @Test("A beta site uses automatic even with a saved Solcast credential")
    func betaIgnoresSavedSolcast() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.solcast.configure(credential: Self.credential, batch: Self.solcastBatch(now: harness.api.now))
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastState == .enhanced)
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        #expect(harness.coordinator.publishedForecastIntervals?.first?.powerKw == 2)
        #expect(harness.coordinator.solarForecastBatch == nil)
        #expect(await harness.solcast.refreshCount == 0)
        let request = try #require(await harness.automatic.requests.last)
        #expect(request.automaticOnly)
    }

    @Test("Changing beta eligibility clears the previous source's published batch")
    func switchingSources() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.solcast.configure(credential: Self.credential, batch: Self.solcastBatch(now: harness.api.now))
        harness.coordinator.historyEnabled = false
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastSource == .solcast)
        #expect(harness.coordinator.publishedForecastIntervals?.first?.powerKw == 3)
        harness.coordinator.historyEnabled = true
        harness.coordinator.invalidateSolarLayout()
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        #expect(harness.coordinator.solarForecastBatch == nil)
        #expect(harness.coordinator.publishedForecastIntervals?.first?.powerKw == 2)
        harness.coordinator.historyEnabled = false
        harness.coordinator.invalidateSolarLayout()
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastSource == .solcast)
        #expect(harness.coordinator.solarForecastPublication == nil)
        #expect(harness.coordinator.publishedForecastIntervals?.first?.powerKw == 3)
    }

    @Test("Missing beta layout, failed lookup and failed automatic provider use history, never saved Solcast")
    func betaUnavailableNeverUsesSolcast() async throws {
        for scenario in 0 ..< 3 {
            let harness = await AutomaticForecastHarness()
            await harness.solcast.configure(credential: Self.credential, batch: Self.solcastBatch(now: harness.api.now))
            if scenario == 0 { try await harness.setNeedsLocation() }
            if scenario == 1 { try await harness.setLowConfidence() }
            if scenario == 2 { await harness.automatic.setFailing(true) }
            harness.coordinator.solarForecastBatch = Self.solcastBatch(now: harness.api.now)
            await harness.coordinator.loadTimingDetailAppeared()
            #expect(harness.coordinator.solarForecastSource == nil, "scenario \(scenario)")
            #expect(harness.coordinator.publishedForecastIntervals == nil)
            #expect(harness.coordinator.householdPattern != nil)
            #expect(await harness.solcast.refreshCount == 0)
        }
    }

    @Test("Manual beta refresh requests fresh automatic data and never refreshes Solcast")
    func manualUsesAutomatic() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.solcast.configure(credential: Self.credential, batch: Self.solcastBatch(now: harness.api.now))
        await harness.coordinator.loadTimingDetailAppeared()
        await harness.coordinator.loadTimingDetailRefreshed()
        let request = try #require(await harness.automatic.requests.last)
        #expect(request.manual)
        #expect(request.automaticOnly)
        #expect(await harness.automatic.refreshes == 2)
        #expect(await harness.solcast.refreshCount == 0)
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

    @Test("Solcast without arrays, or failing, never invokes the automatic provider")
    func solcastSetupOrFailureKeepsSolcast() async throws {
        for (arrays, result) in [
            ([String](), SolarForecastRefreshResult.notConfigured),
            (["r1"], .failed(.requestFailed))] {
            let harness = await AutomaticForecastHarness()
            harness.coordinator.historyEnabled = false
            let credential = SolarForecastCredential(
                accountScopeID: "account-a", siteID: "site-a", credentialID: "cred", resourceIDs: arrays
            )
            await harness.solcast.configure(credential: credential, batch: nil, result: result)
            await harness.coordinator.loadTimingDetailAppeared()
            #expect(harness.coordinator.solarForecastSource != .forecastSolar)
            #expect(await harness.automatic.refreshes == 0)
        }
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
        try await harness.seedCorrection(ratio: 0.8, providerID: .forecastSolar, fingerprint: "stub")
        await harness.coordinator.loadTimingDetailAppeared()
        let corrected = try #require(harness.coordinator.publishedForecastIntervals)
        #expect(corrected.allSatisfy { abs($0.powerKw - 1.6) < 1e-9 })

        let failing = await AutomaticForecastHarness()
        await failing.coordinator.loadTimingDetailAppeared()
        #expect(failing.coordinator.publishedForecastIntervals?.allSatisfy { $0.powerKw == 2 } == true)
    }

    @Test("A Solcast correction policy cannot change the beta site's automatic choice")
    func betaIgnoresSolcastCorrection() async throws {
        let harness = await AutomaticForecastHarness(correctsSolcast: true)
        await harness.solcast.configure(credential: Self.credential, batch: Self.solcastBatch(now: harness.api.now))
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        #expect(harness.coordinator.publishedForecastIntervals?.first?.powerKw == 2)
        #expect(await harness.solcast.refreshCount == 0)
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
        try await harness.seedCorrection(ratio: 0.8, providerID: .forecastSolar, fingerprint: "stub")
        await harness.coordinator.loadTimingDetailAppeared()
        let diagnostics = try #require(await harness.coordinator.solarForecastDiagnostics())
        let source = try #require(diagnostics.source)
        #expect(source.providerID == "forecast-solar")
        #expect(source.configurationRevision == "stub")
        #expect(source.ageMinutes == 0)
        #expect(source.coverageEnd > source.coverageStart)
        #expect(source.sameDaySamples > 0)
        #expect(source.dayAheadFactors.values.allSatisfy { abs($0 - 0.8) < 1e-9 })
        #expect(diagnostics.budget == nil, "The Solcast daily budget is not the automatic budget")
    }
}

extension AutomaticForecastCoordinatorTests {
    @Test("Automatic provider failures remain available to diagnostics")
    func failedAutomaticAttemptIsDiagnosable() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.automatic.setFailing(true)
        await harness.coordinator.loadTimingDetailAppeared()
        let diagnostics = try #require(await harness.coordinator.solarForecastDiagnostics())
        #expect(diagnostics.automaticProviderID == "forecast-solar")
        #expect(diagnostics.automaticRefreshOutcome != nil)
        #expect(harness.coordinator.solarForecastUnavailableReason == .forecastNotUsable)
        #expect(harness.coordinator.publishedForecastIntervals == nil)
    }

    @Test(
        "Cold start on non-beta account learns disabled synchronously, preserves manual, and avoids needsLocation"
    )
    func coldStartDisabledPreservesManual() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        try await harness.setNeedsLocation()
        harness.api.historyResponse = .disabled

        await harness.coordinator.refreshSolarForecast(manual: true)

        #expect(harness.coordinator.solarLayoutStatus == .disabled)
        #expect(!harness.coordinator.historyEnabled)
        #expect(harness.coordinator.solarForecastState == .basic)
        #expect(harness.coordinator.solarForecastSource == nil)
        #expect(await harness.automatic.refreshes == 0)
    }
}
