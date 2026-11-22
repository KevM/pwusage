import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

@Suite("RatePeriodResolver Reference Plans")
struct RatePeriodResolverTests {
    @Test("Reference resolver returns nil when referencePeriods is empty")
    func nilWhenEmpty() {
        let timeline = Self.makeTimeline(referencePeriods: [])
        #expect(RatePeriodResolver(referenceOf: timeline) == nil)
    }

    @Test("Reference resolver prices from reference plans instead of actual plans")
    func referenceResolverPricesFromReferencePlans() throws {
        let actual = Self.makePeriod(id: 1, name: "Actual ToU", from: "2024-01-01", buyRate: 0.35, sellRate: 0.08)
        let ref = Self.makePeriod(id: 2, name: "Fixed Reference", from: "2024-01-01", buyRate: 0.14, sellRate: 0.04)
        let timeline = Self.makeTimeline(periods: [actual], referencePeriods: [ref])

        let resolver = try #require(RatePeriodResolver(referenceOf: timeline))
        let instant = try Self.makeUTCDate(year: 2026, month: 6, day: 15, hour: 12)
        let resolved = resolver.period(at: instant)
        #expect(resolved.planName == "Fixed Reference")
        #expect(resolved.buyRate == 0.14)
        #expect(resolved.sellRate == 0.04)
    }

    @Test("Reference resolver falls back to earliest reference plan before its start")
    func referenceResolverUsesEarliestPlanBeforeItsStart() throws {
        let early = Self.makePeriod(
            id: 10,
            name: "Early Fixed",
            from: "2025-01-01",
            through: "2025-12-31",
            buyRate: 0.12,
            sellRate: 0.03
        )
        let later = Self.makePeriod(
            id: 11,
            name: "Later Fixed",
            from: "2026-01-01",
            through: nil,
            buyRate: 0.16,
            sellRate: 0.04
        )
        let timeline = Self.makeTimeline(referencePeriods: [later, early])

        let resolver = try #require(RatePeriodResolver(referenceOf: timeline))
        let beforeStart = try Self.makeUTCDate(year: 2024, month: 3, day: 1, hour: 12)
        let resolved = resolver.period(at: beforeStart)
        #expect(resolved.planName == "Early Fixed")
        #expect(resolved.buyRate == 0.12)
    }

    private static func makeTimeline(
        periods: [TariffPeriodDTO] = [],
        referencePeriods: [TariffPeriodDTO]
    ) -> SiteTariffsTimelineResponse {
        SiteTariffsTimelineResponse(
            version: 2,
            siteId: "site-1",
            timezone: "UTC",
            currency: "USD",
            periods: periods,
            referencePeriods: referencePeriods,
            battery: nil,
            reattribution: nil,
            holidayDates: [],
            teslaSync: TeslaSyncDTO(
                latestTariffId: nil,
                latestTariffName: nil,
                latestUpdatedAt: nil,
                activeManualUpdatedAt: nil,
                differsFromActiveManual: false, syncAvailable: false, syncUnavailableReason: nil, lastSync: nil
            )
        )
    }

    private static func makePeriod(
        id: Int,
        name: String,
        from: String,
        through: String? = nil,
        buyRate: Double,
        sellRate: Double
    ) -> TariffPeriodDTO {
        let window = TimePeriodWindowInput(
            touName: .offPeak,
            fromHour: 0,
            fromMinute: 0,
            toHour: 24,
            toMinute: 0,
            buyRate: buyRate,
            sellRate: sellRate
        )
        let season = TariffSeasonInput(
            name: "All Year",
            fromMonth: 1,
            toMonth: 12,
            weekdayPeriods: [window],
            weekendPeriods: [window]
        )
        return TariffPeriodDTO(
            periodId: id,
            tariffId: id * 10,
            name: name,
            version: 1,
            source: .manual,
            effectiveFrom: from,
            effectiveTo: through,
            isCurrentToday: true,
            updatedBy: nil,
            seasons: [season]
        )
    }

    private static func makeUTCDate(year: Int, month: Int, day: Int, hour: Int) throws -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        return try #require(calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour)))
    }
}
