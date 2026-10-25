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

        #expect(LoadTimingForecastPresentation.forecastAvailability(
            state: .enhanced, connection: .ready, cause: nil, reason: nil,
            forecastFetchedAt: batch.fetchedAt, now: now
        ) == .ready)
    }
    @Test("Smart Shift preview fixtures render the states they are named for")
    func smartShiftPreviewFixturesMatchTheirNames() throws {
        func verdict(_ fixture: SmartShiftPreviewFixture) throws -> SmartShiftVerdict {
            guard case .verdict(let verdict) = fixture.screen.content else {
                Issue.record("\(fixture) did not produce a verdict: \(fixture.screen.content)")
                throw CancellationError()
            }
            return verdict
        }
        #expect(try verdict(.laterWithForecast).bars.count == 2)
        #expect(try verdict(.laterWithForecast).notes.isEmpty)
        #expect(try verdict(.laterWithoutForecast).bars.count == 2)
        #expect(try verdict(.laterWithoutForecast).notes == [.connectSolcast(usesHistory: false)])
        #expect(try verdict(.nowIsCheapest).bars.count == 1)
        #expect(try verdict(.threePeriods).lanes.count >= 2)
    }
}
