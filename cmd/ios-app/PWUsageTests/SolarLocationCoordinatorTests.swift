import Foundation
@testable import PWUsage
import Testing

@MainActor
final class StubHomeLocationProvider: HomeLocationProviding {
    var result: Result<SolarHomeLocation, any Error>
    var beforeAnswer: (() -> Void)?
    private(set) var requests = 0

    init(_ result: Result<SolarHomeLocation, any Error>) { self.result = result }

    func currentRoundedLocation() async throws -> SolarHomeLocation {
        requests += 1
        beforeAnswer?()
        return try result.get()
    }
}

@MainActor
@Suite("Sharing the home location from the app")
struct SolarLocationCoordinatorTests {
    private static let home = SolarHomeLocation(latitude: 43.39, longitude: -87.87, source: .device)
    private static let estimated = MobileSolarLayoutResponse.enabled(
        location: SolarHomeLocation(latitude: 43.4, longitude: -87.9, source: .estimated),
        layout: AutomaticForecastHarness.detectedLayout, reason: nil
    )

    @Test("Denied permission posts nothing and keeps the history path")
    func denied() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        try await harness.setNeedsLocation()
        await harness.coordinator.loadTimingDetailAppeared()
        let result = await harness.coordinator.shareHomeLocation(
            confirmedSiteID: "site-a", provider: StubHomeLocationProvider(.failure(HomeLocationError.denied))
        )
        #expect(result == .denied)
        #expect(harness.coordinator.solarForecastState == .basic)
        #expect(SolarLocationShareResult.denied.offersOpenSettings)
        #expect(SolarLocationShareResult.restricted.offersOpenSettings)
        #expect(!SolarLocationShareResult.unavailable.offersOpenSettings)
    }

    @Test("A site change after confirmation posts nothing")
    func siteChanged() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        let provider = StubHomeLocationProvider(.success(Self.home))
        provider.beforeAnswer = { harness.coordinator.selectSite("site-b") }
        let result = await harness.coordinator.shareHomeLocation(confirmedSiteID: "site-a", provider: provider)
        #expect(result == .cancelled)
        let wrongSite = await harness.coordinator.shareHomeLocation(confirmedSiteID: "site-a", provider: provider)
        #expect(wrongSite == .cancelled)
        #expect(provider.requests == 1, "No permission prompt for a site that is no longer selected")
    }

    @Test("A shared location is saved locally and shows pending")
    func sharedThenPending() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        try await harness.setNeedsLocation()
        await harness.coordinator.loadTimingDetailAppeared()
        let result = await harness.coordinator.shareHomeLocation(
            confirmedSiteID: "site-a", provider: StubHomeLocationProvider(.success(Self.home))
        )
        #expect(result == .shared)
        #expect(harness.coordinator.solarLayoutStatus == .enabled(location: Self.home, layout: nil, reason: .pending))
    }

    @Test("Sharing a location never calls the network except history sync, updating when runner finishes")
    func sharedThenDetectedWithoutTimer() async throws {
        let harness = await AutomaticForecastHarness(seedDetected: false)
        try await harness.setNeedsLocation()
        await harness.coordinator.loadTimingDetailAppeared()
        let result = await harness.coordinator.shareHomeLocation(
            confirmedSiteID: "site-a", provider: StubHomeLocationProvider(.success(Self.home))
        )
        #expect(result == .shared)
        #expect(harness.coordinator.solarLayoutStatus == .enabled(location: Self.home, layout: nil, reason: .pending))

        // Runner runs in background, performs history sync (the only network call) and detects
        try await eventually {
            harness.coordinator.solarForecastSource == .forecastSolar
        }
        #expect(harness.coordinator.solarLayoutStatus == AutomaticForecastHarness.detectedResponse)
        // A single initial sync issues exactly two fetches: the 364-day UTC discovery page,
        // followed by the 365-day site-local exact start page (Task 7 contract).
        #expect(harness.api.historyFetches.count == 2)
    }

    @Test("Refining an estimated location keeps the forecast, then stops offering refinement")
    func refineEstimated() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        let result = await harness.coordinator.shareHomeLocation(
            confirmedSiteID: "site-a", provider: StubHomeLocationProvider(.success(Self.home))
        )
        #expect(result == .shared)
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        #expect(SolarLocationInvitation.kind(status: harness.coordinator.solarLayoutStatus) == nil)
    }
}
