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
        let harness = AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        let coordinator = harness.coordinator
        #expect(coordinator.solarForecastState == .enhanced)
        #expect(coordinator.solarForecastSource == .forecastSolar)
        #expect(coordinator.solarForecastConnection == .notConnected)
        #expect(coordinator.forecastConnectionForConsumers == .ready)
        let intervals = try #require(coordinator.publishedForecastIntervals)
        #expect(intervals.allSatisfy { $0.powerKw == 2 })
        #expect(coordinator.solarForecastAttribution == "Forecast by Forecast.Solar.")
        #expect(coordinator.solarLayoutStatus == AutomaticForecastAPISpy.detected)
    }

    @Test("A connected Solcast wins; the automatic provider is never refreshed")
    func solcastWins() async {
        let harness = AutomaticForecastHarness()
        await harness.solcast.configure(credential: Self.credential, batch: Self.solcastBatch(now: harness.api.now))
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastState == .enhanced)
        #expect(harness.coordinator.solarForecastSource == .solcast)
        #expect(harness.coordinator.publishedForecastIntervals?.first?.powerKw == 3)
        #expect(harness.coordinator.solarForecastAttribution == nil)
        #expect(await harness.automatic.refreshes == 0)
        #expect(harness.api.layoutSiteIDs == ["site-a"], "Layout status is still read for settings")
        #expect(harness.api.actualsSiteIDs.isEmpty)
    }

    @Test("Switching between Solcast and automatic never shows the other source's batch")
    func switchingSources() async {
        let harness = AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        await harness.solcast.configure(credential: Self.credential, batch: Self.solcastBatch(now: harness.api.now))
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastSource == .solcast)
        #expect(harness.coordinator.publishedForecastIntervals?.first?.powerKw == 3)
        await harness.solcast.configure(credential: nil, batch: nil)
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        #expect(harness.coordinator.publishedForecastIntervals?.first?.powerKw == 2)
    }

    @Test("Outside the beta: no actuals, no automatic refresh, basic estimate")
    func disabled() async {
        let harness = AutomaticForecastHarness()
        harness.api.layout = .disabled
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastState == .basic)
        #expect(harness.coordinator.solarForecastSource == nil)
        #expect(harness.coordinator.householdPattern != nil)
        #expect(harness.api.actualsSiteIDs.isEmpty)
        #expect(await harness.automatic.refreshes == 0)
    }

    @Test("Solcast without arrays, or failing, never invokes the automatic provider")
    func solcastSetupOrFailureKeepsSolcast() async {
        for (arrays, result) in [
            ([String](), SolarForecastRefreshResult.notConfigured),
            (["r1"], .failed(.requestFailed))] {
            let harness = AutomaticForecastHarness()
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
    func lowConfidence() async {
        let harness = AutomaticForecastHarness()
        harness.api.layout = .enabled(location: nil, layout: nil, reason: .lowConfidence)
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastState == .basic)
        #expect(harness.coordinator.solarLayoutStatus == .enabled(location: nil, layout: nil, reason: .lowConfidence))
        #expect(await harness.automatic.refreshes == 0)
    }

    @Test("Correction scales the automatic forecast; failed actuals leave it raw")
    func correction() async throws {
        let harness = AutomaticForecastHarness()
        await harness.seedCorrection(ratio: 0.8, providerID: .forecastSolar, fingerprint: "stub")
        await harness.coordinator.loadTimingDetailAppeared()
        let corrected = try #require(harness.coordinator.publishedForecastIntervals)
        #expect(corrected.allSatisfy { abs($0.powerKw - 1.6) < 1e-9 })

        let failing = AutomaticForecastHarness()
        await failing.seedCorrection(ratio: 0.8, providerID: .forecastSolar, fingerprint: "stub")
        failing.api.actualsError = URLError(.timedOut)
        await failing.coordinator.loadTimingDetailAppeared()
        #expect(failing.coordinator.publishedForecastIntervals?.allSatisfy { $0.powerKw == 2 } == true)
    }

    @Test("Solcast is corrected only when the policy says so")
    func solcastCorrection() async throws {
        let harness = AutomaticForecastHarness(correctsSolcast: true)
        await harness.solcast.configure(credential: Self.credential, batch: Self.solcastBatch(now: harness.api.now))
        let fingerprint = SolcastForecastProvider.fingerprint(credentialID: "cred", resourceIDs: ["r1"])
        await harness.seedCorrection(ratio: 0.8, providerID: .solcast, fingerprint: fingerprint)
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.api.actualsSiteIDs == ["site-a"])
        let today = try #require(harness.coordinator.publishedForecastIntervals?.first)
        #expect(abs(today.powerKw - 2.4) < 1e-9)

        let uncorrected = AutomaticForecastHarness()
        await uncorrected.solcast.configure(
            credential: Self.credential,
            batch: Self.solcastBatch(now: uncorrected.api.now)
        )
        await uncorrected.seedCorrection(ratio: 0.8, providerID: .solcast, fingerprint: fingerprint)
        await uncorrected.coordinator.loadTimingDetailAppeared()
        #expect(uncorrected.api.actualsSiteIDs.isEmpty)
        #expect(uncorrected.coordinator.publishedForecastIntervals?.first?.powerKw == 3)
    }

    @Test("A suspended site A response is dropped after switching to site B")
    func siteSwitchDropsOldResponse() async throws {
        let harness = AutomaticForecastHarness()
        harness.api.holdLayout = true
        let pending = Task { await harness.coordinator.loadTimingDetailAppeared() }
        while harness.api.layoutSiteIDs.isEmpty { await Task.yield() }
        harness.api.layout = .disabled
        harness.coordinator.selectSite("site-b")
        harness.api.resumeLayout()
        await pending.value
        #expect(harness.coordinator.solarForecastSource == nil)
        #expect(harness.coordinator.publishedForecastIntervals == nil)
        #expect(harness.coordinator.solarLayoutStatus == nil)
    }

    @Test("Diagnostics name the provider, revision, age, coverage and factors without secrets")
    func diagnostics() async throws {
        let harness = AutomaticForecastHarness()
        await harness.seedCorrection(ratio: 0.8, providerID: .forecastSolar, fingerprint: "stub")
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
