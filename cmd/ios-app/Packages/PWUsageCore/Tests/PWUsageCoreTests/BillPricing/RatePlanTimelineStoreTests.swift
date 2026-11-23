import Foundation
@testable import PWUsageCore
import Testing

@Suite("Rate plan timeline store")
struct RatePlanTimelineStoreTests {
    private let scopeA = SolarForecastSiteScope(accountScopeID: "account-1", siteID: "a")
    private let scopeB = SolarForecastSiteScope(accountScopeID: "account-1", siteID: "b")
    private let otherAccountScope = SolarForecastSiteScope(accountScopeID: "account-2", siteID: "a")

    @Test("Saves and reads per account and site scope")
    func savesAndReadsPerScope() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = RatePlanTimelineStore(directory: folder)
        let fixture = try BillPricingFixture.load("single-plan-cycle").timeline
        let timelineA = Self.makeTimeline(fixture, siteID: "a")
        let timelineB = Self.makeTimeline(fixture, siteID: "b")
        let timelineOtherAccount = Self.makeTimeline(fixture, siteID: "a", currency: "EUR")

        try await store.save(timelineA, etag: "\"etag-a\"", scope: scopeA)
        try await store.save(timelineB, etag: "\"etag-b\"", scope: scopeB)
        try await store.save(timelineOtherAccount, etag: "\"etag-other\"", scope: otherAccountScope)

        let reloaded = RatePlanTimelineStore(directory: folder)
        let savedA = try #require(await reloaded.saved(scope: scopeA))
        let savedB = try #require(await reloaded.saved(scope: scopeB))
        let savedOther = try #require(await reloaded.saved(scope: otherAccountScope))

        #expect(savedA.timeline == timelineA)
        #expect(savedA.etag == "\"etag-a\"")
        #expect(savedB.timeline == timelineB)
        #expect(savedB.etag == "\"etag-b\"")
        #expect(savedOther.timeline == timelineOtherAccount)
        #expect(savedOther.etag == "\"etag-other\"")
    }

    private static func makeTimeline(
        _ timeline: SiteTariffsTimelineResponse,
        siteID: String,
        currency: String = "USD"
    ) -> SiteTariffsTimelineResponse {
        SiteTariffsTimelineResponse(
            version: timeline.version,
            siteId: siteID,
            timezone: timeline.timezone,
            currency: currency,
            periods: timeline.periods,
            referencePeriods: timeline.referencePeriods,
            battery: timeline.battery,
            reattribution: timeline.reattribution,
            holidayDates: timeline.holidayDates,
            teslaSync: timeline.teslaSync,
            estimates: timeline.estimates,
            systemCosts: timeline.systemCosts,
            rateCountry: timeline.rateCountry
        )
    }
}
