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
        layout: AutomaticForecastAPISpy.detected.layoutForTests, reason: nil
    )

    @Test("Denied permission posts nothing and keeps the history path")
    func denied() async {
        let harness = AutomaticForecastHarness()
        harness.api.layout = .enabled(location: nil, layout: nil, reason: .needsLocation)
        await harness.coordinator.loadTimingDetailAppeared()
        let result = await harness.coordinator.shareHomeLocation(
            confirmedSiteID: "site-a", provider: StubHomeLocationProvider(.failure(HomeLocationError.denied))
        )
        #expect(result == .denied)
        #expect(harness.api.postedLocations.isEmpty)
        #expect(harness.coordinator.solarForecastState == .basic)
        #expect(SolarLocationShareResult.denied.offersOpenSettings)
        #expect(SolarLocationShareResult.restricted.offersOpenSettings)
        #expect(!SolarLocationShareResult.unavailable.offersOpenSettings)
    }

    @Test("A site change after confirmation posts nothing")
    func siteChanged() async {
        let harness = AutomaticForecastHarness()
        let provider = StubHomeLocationProvider(.success(Self.home))
        provider.beforeAnswer = { harness.coordinator.selectSite("site-b") }
        let result = await harness.coordinator.shareHomeLocation(confirmedSiteID: "site-a", provider: provider)
        #expect(result == .cancelled)
        #expect(harness.api.postedLocations.isEmpty)
        let wrongSite = await harness.coordinator.shareHomeLocation(confirmedSiteID: "site-a", provider: provider)
        #expect(wrongSite == .cancelled)
        #expect(provider.requests == 1, "No permission prompt for a site that is no longer selected")
    }

    @Test("A shared location is posted, then the layout is read again and shows pending")
    func sharedThenPending() async {
        let harness = AutomaticForecastHarness()
        harness.api.layout = .enabled(location: nil, layout: nil, reason: .needsLocation)
        await harness.coordinator.loadTimingDetailAppeared()
        harness.api.layout = .enabled(location: Self.home, layout: nil, reason: .pending)
        let result = await harness.coordinator.shareHomeLocation(
            confirmedSiteID: "site-a", provider: StubHomeLocationProvider(.success(Self.home))
        )
        #expect(result == .shared)
        #expect(harness.api.postedLocations == [.init(siteID: "site-a", latitude: 43.39, longitude: -87.87)])
        #expect(harness.api.layoutSiteIDs.count == 2)
        #expect(harness.coordinator.solarLayoutStatus == .enabled(location: Self.home, layout: nil, reason: .pending))
    }

    @Test("Refining an estimated location keeps the forecast, then stops offering refinement")
    func refineEstimated() async {
        let harness = AutomaticForecastHarness()
        harness.api.layout = Self.estimated
        await harness.coordinator.loadTimingDetailAppeared()
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        #expect(SolarLocationInvitation
            .kind(status: harness.coordinator.solarLayoutStatus, hasSolcast: false) == .estimated)
        harness.api.layout = AutomaticForecastAPISpy.detected
        let result = await harness.coordinator.shareHomeLocation(
            confirmedSiteID: "site-a", provider: StubHomeLocationProvider(.success(Self.home))
        )
        #expect(result == .shared)
        #expect(harness.coordinator.solarForecastSource == .forecastSolar)
        #expect(SolarLocationInvitation.kind(status: harness.coordinator.solarLayoutStatus, hasSolcast: false) == nil)
    }

    @Test("A failed post reports failure and posts are never retried automatically")
    func postFailure() async {
        let harness = AutomaticForecastHarness()
        harness.api.postError = PWUsageAPIError.requestRejected(statusCode: 403, message: nil)
        let result = await harness.coordinator.shareHomeLocation(
            confirmedSiteID: "site-a", provider: StubHomeLocationProvider(.success(Self.home))
        )
        #expect(result == .failed)
        #expect(harness.api.layoutSiteIDs.isEmpty)
    }
}

extension MobileSolarLayoutResponse {
    var layoutForTests: SolarLayout? {
        guard case .enabled(_, let layout, _) = self else { return nil }
        return layout
    }
}
