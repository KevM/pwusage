import Foundation
import Testing
@testable import PWUsage

/// Preview fixtures are only useful if they exercise the paths that matter. These
/// guard the properties that silently change what the preview screens show.
@Suite("Preview Fixture Tests")
@MainActor
struct PreviewFixtureTests {
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
}
