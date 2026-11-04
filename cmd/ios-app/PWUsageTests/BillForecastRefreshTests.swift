import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Bill forecast during a refresh")
struct BillForecastRefreshTests {
    @Test("A fresh forecast keeps pricing the bill while a refresh is in flight")
    func freshForecastSurvivesRefresh() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        let published = try #require(harness.coordinator.publishedForecastIntervals)
        let now = harness.coordinator.now()

        harness.coordinator.solarForecastState = .loadingWithBasic

        #expect(harness.coordinator.pricingForecastIntervals(at: now) == published)
    }

    @Test("A stale forecast does not price the bill, whatever the state")
    func staleForecastIsDropped() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        let fetchedAt = try #require(harness.coordinator.publishedForecastFetchedAt)
        let stale = fetchedAt.addingTimeInterval(LoadTimingForecastPresentation.maximumForecastAge + 1)

        #expect(harness.coordinator.pricingForecastIntervals(at: stale).isEmpty)
        harness.coordinator.solarForecastState = .loadingWithBasic
        #expect(harness.coordinator.pricingForecastIntervals(at: stale).isEmpty)
    }

    @Test("A failed forecast does not price the bill")
    func failedForecastIsDropped() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared()
        let now = harness.coordinator.now()

        harness.coordinator.solarForecastState = .failedWithBasic

        #expect(harness.coordinator.pricingForecastIntervals(at: now).isEmpty)
    }

    @Test("The projection waits for the first forecast load to finish")
    func pendingUntilFirstLoadFinishes() async {
        let harness = await AutomaticForecastHarness()
        #expect(harness.coordinator.billProjectionIsPending(at: harness.coordinator.now()))

        await harness.coordinator.loadTimingDetailAppeared(surface: nil)

        #expect(!harness.coordinator.billProjectionIsPending(at: harness.coordinator.now()))
    }

    @Test("A household pattern alone does not end the wait for the forecast")
    func patternAloneKeepsWaiting() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.automatic.setHold(true)
        let pending = Task { await harness.coordinator.loadTimingDetailAppeared(surface: nil) }
        try await eventually { harness.coordinator.householdPattern != nil }

        #expect(harness.coordinator.billProjectionIsPending(at: harness.coordinator.now()))

        await harness.automatic.resume()
        await pending.value
        #expect(!harness.coordinator.billProjectionIsPending(at: harness.coordinator.now()))
    }

    @Test("A site without a forecast stops waiting once the load finishes")
    func settlesWithoutForecast() async {
        let harness = await AutomaticForecastHarness()
        harness.coordinator.historyEnabled = false

        await harness.coordinator.loadTimingDetailAppeared(surface: nil)

        #expect(!harness.coordinator.billProjectionIsPending(at: harness.coordinator.now()))
    }

    @Test("A forecast refresh also ends the first wait")
    func refreshSettles() async {
        let harness = await AutomaticForecastHarness()

        await harness.coordinator.refreshSolarForecast(manual: false)

        #expect(!harness.coordinator.billProjectionIsPending(at: harness.coordinator.now()))
    }

    @Test("Switching site waits for the new site's forecast")
    func siteSwitchWaitsAgain() async {
        let harness = await AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared(surface: nil)

        harness.coordinator.selectSite("site-b")

        #expect(harness.coordinator.billProjectionIsPending(at: harness.coordinator.now()))
    }

    @Test("A reload keeps the projection while the forecast is fresh, and waits once it is stale")
    func reloadWaitsOnlyWhenStale() async throws {
        let harness = await AutomaticForecastHarness()
        await harness.coordinator.loadTimingDetailAppeared(surface: nil)
        let fetchedAt = try #require(harness.coordinator.publishedForecastFetchedAt)
        let stale = fetchedAt.addingTimeInterval(LoadTimingForecastPresentation.maximumForecastAge + 1)

        harness.coordinator.solarForecastState = .loadingWithBasic

        #expect(!harness.coordinator.billProjectionIsPending(at: fetchedAt))
        #expect(harness.coordinator.billProjectionIsPending(at: stale))
    }

    @Test("Nothing is pending without account access")
    func noWaitWithoutAccess() async {
        let harness = await AutomaticForecastHarness()

        harness.coordinator.sessionVerified = false

        #expect(!harness.coordinator.billProjectionIsPending(at: harness.coordinator.now()))
    }
}
