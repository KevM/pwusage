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

    @Test("Joined runIfDue reruns detection when home location changes mid-flight")
    func joinedRunIfDueRerunsAfterMidFlightLocationChange() async throws {
        let scope = SolarForecastSiteScope(accountScopeID: "acc", siteID: "site")
        let tempRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let records = SolarLayoutRecordStore(directory: tempRoot.appendingPathComponent("records"))
        let history = SolarHistoryStore(directory: tempRoot.appendingPathComponent("history"))
        let now = Date(timeIntervalSince1970: 1_000_000)
        try await records.setLocation(Self.home, scope: scope, at: now)
        let day = MobileSolarHistoryDay(
            day: "2026-10-31", dayStart: now, status: .complete,
            fetchedAt: now, solarWh: Array(repeating: 0, count: 288)
        )
        let page = MobileSolarHistoryResponse.enabled(timeZone: .gmt, days: [day], nextFrom: nil)
        let api = HistoryAPI(responses: [page, page, page, page])
        let gate = DetectionGate()
        let detected = DetectedSolarLayout(
            status: .detected, confidence: nil, reasons: [], planes: [],
            acClipKw: nil, historyDays: 0, clearDays: 0, firstDay: nil, lastDay: nil
        )
        let runner = SolarLayoutDetectionRunner(
            history: history,
            records: records,
            api: api,
            detect: { _, _, _, _, _ in
                gate.onDetect()
                return detected
            },
            now: { now }
        )
        var changedCount = 0
        runner.onRecordChanged = { _ in changedCount += 1 }

        let task1 = Task { await runner.runIfDue(scope: scope) }
        await gate.waitUntilStarted()
        let updatedLoc = SolarHomeLocation(latitude: 45.0, longitude: -90.0, source: .device)
        try await records.setLocation(updatedLoc, scope: scope, at: now.addingTimeInterval(1))
        let task2 = Task { await runner.runIfDue(scope: scope) }
        gate.proceed()

        let (res1, res2) = (await task1.value, await task2.value)
        #expect(res1 == nil)
        #expect(res2?.location == updatedLoc)
        #expect(res2?.result == detected)
        #expect(changedCount == 1)
    }
}
