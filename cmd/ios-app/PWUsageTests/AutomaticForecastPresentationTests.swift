import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Automatic solar forecast presentation and visibility")
struct AutomaticForecastPresentationTests {
    @Test("Unknown eligibility stays checking while the actual layout request is pending")
    func checkingDuringLookup() async throws {
        let harness = AutomaticForecastHarness()
        #expect(harness.coordinator.forecastConnectionForConsumers == .checking)
        harness.api.holdLayout = true
        let load = Task { await harness.coordinator.loadTimingDetailAppeared() }
        try await eventually { harness.api.layoutSiteIDs.count == 1 }
        #expect(harness.coordinator.forecastConnectionForConsumers == .checking)
        harness.api.resumeLayout()
        await load.value
        #expect(harness.coordinator.forecastConnectionForConsumers == .ready)
    }

    @Test("A beta setup problem offers automatic settings rather than Connect Solcast")
    func betaSetupAvailability() {
        let statuses: [MobileSolarLayoutResponse] = [
            .enabled(location: nil, layout: nil, reason: .needsLocation),
            .enabled(location: SolarProviderFixture.location, layout: nil, reason: .pending),
            .enabled(location: SolarProviderFixture.location, layout: nil, reason: .lowConfidence),
            .enabled(location: SolarProviderFixture.location, layout: nil, reason: .notEnoughHistory)]
        for status in statuses {
            let availability = LoadTimingForecastPresentation.forecastAvailability(
                state: .basic, connection: .notConnected, cause: nil, reason: nil,
                forecastFetchedAt: nil, now: .now, usesAutomaticForecast: true, automaticStatus: status
            )
            guard case .automaticUnavailable(let message) = availability else {
                Issue.record("Beta setup must not be represented as a missing Solcast connection")
                continue
            }
            #expect(!message.contains("Solcast"))
            #expect(!message.isEmpty)
        }
    }

    @Test("An automatic failure remains usable through history rather than loading forever")
    func completedFailure() async {
        let harness = AutomaticForecastHarness()
        await harness.automatic.setFailing(true)
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.forecastConnectionForConsumers != .checking)
        #expect(harness.coordinator.householdPattern != nil)
    }

    @Test("Automatic forecasts trigger the same energy aging refresh as Solcast")
    func automaticEnergyAging() async throws {
        let harness = AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        let through = try #require(harness.coordinator.bill.response?.sources.energyDataThrough)
        #expect(harness.coordinator.solarForecastConnection != .ready)
        #expect(harness.coordinator.energyDataIsAgingForForecast(
            at: through.addingTimeInterval(DashboardCoordinator.forecastEnergyDataRefreshAge)
        ))
    }

    @Test("Closing settings does not hide the Bill surface underneath")
    func overlappingSurfaces() async {
        let harness = AutomaticForecastHarness()
        harness.coordinator.scenePhaseChanged(isActive: true)
        harness.api.layout = .enabled(location: SolarProviderFixture.location, layout: nil, reason: .pending)
        await harness.coordinator.billOutlookAppeared()
        await harness.coordinator.solarSettingsAppeared()
        harness.coordinator.solarSurfaceDisappeared(.settings)
        #expect(harness.coordinator.solarSurfaceVisible)
        #expect(harness.scheduler.pending.count == 1)
        harness.coordinator.solarSurfaceDisappeared(.bill)
        #expect(!harness.coordinator.solarSurfaceVisible)
        #expect(harness.scheduler.pending.isEmpty)
    }

    @Test("A timer refresh cannot create a new visible Smart Shift surface")
    func internalRefreshPreservesSurfaces() async {
        let harness = AutomaticForecastHarness()
        harness.coordinator.scenePhaseChanged(isActive: true)
        harness.api.layout = .enabled(location: SolarProviderFixture.location, layout: nil, reason: .pending)
        await harness.coordinator.billOutlookAppeared()
        harness.api.clock.advance(by: 15 * 60)
        await harness.scheduler.fire()
        harness.coordinator.solarSurfaceDisappeared(.bill)
        #expect(!harness.coordinator.solarSurfaceVisible)
        #expect(harness.scheduler.pending.isEmpty)
    }

    @Test("Open-Meteo attribution links to the weather data source")
    func weatherSourceLink() {
        let descriptor = OpenMeteoProvider().descriptor
        #expect(descriptor.attributionURL?.absoluteString == "https://open-meteo.com/")
    }

    @Test("Attribution is attached only to a projection that used the published forecast")
    func attributionRequiresSolarUse() async throws {
        let harness = AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.attributionDescriptor(usesSolar: false) == nil)
        let source = try #require(harness.coordinator.attributionDescriptor(usesSolar: true))
        #expect(source.id == .forecastSolar)
        #expect(source.attribution == "Forecast by Forecast.Solar.")
    }
}

extension AutomaticForecastPresentationTests {
    @Test("A newer operation clears the pending state owned by a superseded load")
    func supersededLoadDoesNotLeavePending() async throws {
        let harness = AutomaticForecastHarness()
        harness.api.holdLayout = true
        let load = Task { await harness.coordinator.loadTimingDetailAppeared() }
        try await eventually { harness.api.layoutSiteIDs.count == 1 }
        #expect(harness.coordinator.forecastOperationPending)
        _ = harness.coordinator.beginForecastOperation()
        harness.api.resumeLayout()
        await load.value
        #expect(!harness.coordinator.forecastOperationPending)
    }

    @Test("Confirmed legacy sites cannot expose an automatic attempt from the previous role")
    func legacyDiagnosticsDoNotRetainAutomaticFailure() async throws {
        let harness = AutomaticForecastHarness()
        harness.api.layout = .disabled
        harness.coordinator.solarForecastAttempt = .init(
            providerID: .openMeteo, outcome: .failed(.transient), diagnostic: "Old automatic request failed")
        await harness.coordinator.loadTimingDetailAppeared()
        let diagnostics = try #require(await harness.coordinator.solarForecastDiagnostics())
        #expect(diagnostics.automaticProviderID == nil)
        #expect(diagnostics.automaticRefreshOutcome == nil)
        #expect(diagnostics.automaticDiagnostic == nil)
    }

    @Test("Direct legacy refresh without credentials clears inherited automatic failure state")
    func directLegacyRefreshClearsAutomaticFailure() async {
        let harness = AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        harness.coordinator.solarForecastUnavailableReason = .forecastNotUsable
        harness.coordinator.solarForecastUnavailableCause = .requestFailed
        harness.api.layout = .disabled
        harness.coordinator.invalidateSolarLayout()
        await harness.coordinator.refreshSolarForecast(manual: true)
        #expect(harness.coordinator.solarForecastUnavailableReason == nil)
        #expect(harness.coordinator.solarForecastUnavailableCause == nil)
        #expect(harness.coordinator.publishedForecastIntervals == nil)
        #expect(harness.coordinator.loadPlanningContext == nil)
    }
}
