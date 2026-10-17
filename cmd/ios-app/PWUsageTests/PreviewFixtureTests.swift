import Foundation
import Testing
@testable import PWUsage

/// Preview fixtures are only useful if they exercise the paths that matter. These
/// guard the properties that silently change what the preview screens show.
@Suite("Preview Fixture Tests")
@MainActor
struct PreviewFixtureTests {
    /// A preview payload that cannot decode must fail the one call that needed it,
    /// with the error attached, and not take the test binary down with it. This file
    /// used to decode in its initializer with `try!`, so a bad fixture was a
    /// `SIGTRAP` in the middle of an unrelated suite.
    @Test("A preview payload that cannot decode throws from the fetch, not the process")
    func undecodablePreviewPayloadThrowsFromTheFetch() async throws {
        let api = DashboardPreviewAPI(mode: .normal, liveJSON: #"{"version":1}"#, billJSON: #"{}"#)
        await #expect(throws: (any Error).self) { try await api.fetchLive(siteID: "preview-home") }
        await #expect(throws: (any Error).self) { try await api.fetchBill(siteID: "preview-home") }
    }

    /// The multi-site previews in `app-tab-view.swift` start from this model.
    /// It must come up signed in on the first site, load that site, and load the
    /// next one after a switch, or the canvas has nothing to show.
    @Test("The multi-site preview model loads each site it switches to")
    func multiSitePreviewModelLoadsEachSite() async throws {
        let model = PWUsageAppModel.preview(tab: .settings)
        #expect(model.screenState == .signedIn)
        #expect(model.selectedTab == .settings)
        #expect(model.sites.count == MultiSitePreviewAPI.sites.count)
        let coordinator = try #require(model.coordinator)
        coordinator.scenePhaseChanged(isActive: true)
        coordinator.authenticationRestored()
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(coordinator.live.response?.site.id == "preview-home")

        let cabin = MultiSitePreviewAPI.sites[1]
        model.selectSite(cabin)
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(coordinator.live.response?.site.id == cabin.id)
        #expect(coordinator.live.response?.site.name == cabin.name)
    }

    @Test("Preview tariff data contrasts on-peak against off-peak")
    func previewTariffHasRateContrast() async throws {
        let response = try await DashboardPreviewAPI(mode: .normal).fetchBill(siteID: "preview-home")
        let timing = try #require(response.loadTiming)
        let peak = try #require(timing.periods.first { $0.name == "Peak" })
        let offPeak = try #require(timing.periods.first { $0.name == "Off peak" })

        // A surplus in both periods would render two identical sell rates and
        // hide the whole point of a time-of-use tariff.
        #expect(peak.marginalCost == 0.48)
        #expect(offPeak.marginalCost == 0.12)
        #expect(peak.marginalCost ?? 0 > offPeak.marginalCost ?? 0)
    }

    @Test("The default preview exercises the no-suggestion forecast placement")
    func previewExercisesExplorerPlacement() async throws {
        let api = DashboardPreviewAPI(mode: .normal)
        let response = try await api.fetchBill(siteID: "preview-home")
        let timing = try #require(response.loadTiming)
        let washer = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3, durationHours: 1, carSettings: nil)

        let recommendation = LoadTimingRecommendation.evaluate(
            profiles: [washer],
            start: Date.now,
            timing: timing,
            energyDataThrough: response.sources.energyDataThrough,
            cycleEnd: response.currentBill.cycleEnd,
            refreshUnavailable: false
        )

        // Peak is a net buyer, so the basic layer cannot recommend a load. This is
        // the case that hides the forecast when it is attached to the suggestion.
        #expect(recommendation.suggested == nil)
        let placement = try #require(
            LoadTimingForecastPresentation.placement(recommendation: recommendation, explicitExploredID: nil)
        )
        #expect(placement.card == .explorer)
    }

    /// The whole point of the solar previews is to reach the enhanced state. A
    /// silent mismatch between the bill's site timezone and the planning context's
    /// makes the coordinator reject the enhancement, so every preview shows the
    /// "forecast unavailable" note instead of a forecast.
    @Test("The solar preview reaches the enhanced state without a real Solcast key")
    func solarPreviewReachesEnhanced() async {
        let now = Date.now
        let coordinator = DashboardCoordinator(
            siteID: "preview-home",
            api: DashboardPreviewAPI(mode: .normal),
            planningAPI: PreviewPlanningAPI(mode: .combinedArrays, now: now),
            forecastStore: PreviewForecastStore(mode: .combinedArrays, now: now),
            accountScopeID: "preview-account",
            now: { now },
            timerInterval: nil
        )
        coordinator.scenePhaseChanged(isActive: true)
        await coordinator.loadTimingDetailAppeared()

        #expect(coordinator.solarForecastConnection == .ready)
        #expect(coordinator.solarForecastState == .enhanced,
                "The preview must render a real forecast comparison, not the fallback note")
        #expect(coordinator.solarForecastBatch?.intervals.isEmpty == false)
        #expect(coordinator.loadPlanningContext != nil)
    }

    @Test("The preview planning context uses the same timezone as the preview bill")
    func previewTimezonesAgree() async throws {
        let response = try await DashboardPreviewAPI(mode: .normal).fetchBill(siteID: "preview-home")
        let context = try await PreviewPlanningAPI(mode: .combinedArrays, now: Date.now)
            .fetchLoadPlanningContext(siteID: "preview-home")

        #expect(response.site.timezone == context.site.timezone)
    }

    @Test("Preview forecast data produces an actual cost comparison")
    func previewForecastProducesComparison() async throws {
        let response = try await DashboardPreviewAPI(mode: .normal).fetchBill(siteID: "preview-home")
        let timing = try #require(response.loadTiming)
        // Take "now" from the fixture rather than the wall clock: the API captures
        // its own instant when constructed, so a wall-clock `now` can land
        // fractionally before the balance source time and flake.
        let now = try #require(response.sources.energyDataThrough)
        let context = try await PreviewPlanningAPI(mode: .combinedArrays, now: now)
            .fetchLoadPlanningContext(siteID: "preview-home")
        let estimatorContext = try #require(context.estimatorContext)
        let store = PreviewForecastStore(mode: .combinedArrays, now: now)
        let batch = try #require(await store.cachedBatch(accountScopeID: "preview-account", siteID: "preview-home"))
        let washer = LoadProfile(id: "washer", name: "Washer", kind: .appliance, energyKwh: 3, durationHours: 1, carSettings: nil)

        let result = LoadTimingForecastEstimator.evaluate(
            profile: washer,
            now: now,
            timing: timing,
            forecast: batch.intervals,
            context: estimatorContext,
            balanceSourceTime: try #require(response.sources.energyDataThrough),
            billingCycleEnd: response.currentBill.cycleEnd,
            currencyCode: response.currentBill.currency
        )
        let comparison = try #require(result.comparison, "The preview must produce real numbers, not a fallback: \(String(describing: result.unavailableReason))")

        #expect(comparison.recommendedEnd > comparison.recommendedStart)
        #expect(comparison.horizonEnd > comparison.horizonStart)
        #expect(comparison.evaluatedStarts.count > 1)
        #expect(comparison.estimatedSolarContribution >= 0)

        // And the overlay must turn that comparison into visible forecast copy.
        let overlay = LoadTimingForecastPresentation.overlay(
            enhancement: .enhanced,
            connection: .ready,
            cause: nil,
            result: .init(comparison: comparison, unavailableReason: nil),
            forecastFetchedAt: batch.fetchedAt,
            contextAsOf: context.asOf,
            currencyCode: response.currentBill.currency,
            timeZone: response.site.timezone,
            now: now
        )
        let enhanced = try #require(overlay.enhanced)
        #expect(overlay.isForecastAware)
        #expect(enhanced.recommendedCost.contains("$"))
        #expect(!enhanced.horizon.isEmpty)
    }
}
