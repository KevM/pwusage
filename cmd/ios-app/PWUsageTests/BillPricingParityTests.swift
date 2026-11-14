import Foundation
@testable import PWUsage
import Testing

@Suite(.serialized)
struct BillPricingParityTests {
    private struct PeriodGroupKey: Hashable {
        let planName: String
        let periodName: String
    }

    private struct ComputedPeriodSummary: Equatable {
        let netGridKwh: Double
        let cost: Double
    }

    private static func computeBill(
        fixture: BillPricingFixture
    ) throws -> (periods: [PeriodGroupKey: ComputedPeriodSummary], totalCost: Double) {
        let resolver = try #require(RatePeriodResolver(timeline: fixture.timeline))
        let flowDays = fixture.days.map { $0.asEnergyFlowDay() }
        let buckets = BillUsageAggregator.buckets(
            days: flowDays,
            from: fixture.expected.currentBill.cycleStart,
            to: fixture.expected.currentBill.cycleEnd,
            resolver: resolver
        )
        let bucketCosts = BillPricing.costs(buckets)
        #expect(bucketCosts.count == buckets.count)

        var grouped: [PeriodGroupKey: ComputedPeriodSummary] = [:]
        var totalCost = 0.0
        for (bucket, cost) in zip(buckets, bucketCosts) {
            let key = PeriodGroupKey(planName: bucket.planName, periodName: bucket.periodName)
            let existing = grouped[key] ?? ComputedPeriodSummary(netGridKwh: 0, cost: 0)
            grouped[key] = ComputedPeriodSummary(
                netGridKwh: existing.netGridKwh + bucket.gridWh / 1000.0,
                cost: existing.cost + cost
            )
            totalCost += cost
        }
        return (grouped, totalCost)
    }

    private static let directParityFixtureNames = BillPricingFixture.allNames.filter { $0 != "uncovered-window" }

    @Test(arguments: directParityFixtureNames)
    func currentBillMatchesServer(name: String) throws {
        let fixture = try BillPricingFixture.load(name)
        let computed = try Self.computeBill(fixture: fixture)
        try Self.assertMatchesExpected(computed: computed, expected: fixture.expected.currentBill)
    }

    private static func assertMatchesExpected(
        computed: (periods: [PeriodGroupKey: ComputedPeriodSummary], totalCost: Double),
        expected currentBill: BillPricingFixture.CurrentBill
    ) throws {
        #expect(computed.periods.count == currentBill.periods.count)
        for expected in currentBill.periods {
            let key = PeriodGroupKey(planName: expected.tariffName, periodName: expected.periodName)
            let actual = try #require(
                computed.periods[key],
                "Missing period \(expected.tariffName)/\(expected.periodName)"
            )
            #expect(abs(actual.netGridKwh - expected.netGridKwh) <= 1e-9)
            #expect(abs(actual.cost - expected.cost) <= 1e-9)
        }
        let expectedTotal = currentBill.estimatedCost ?? 0
        #expect(abs(computed.totalCost - expectedTotal) <= 1e-9)
    }

    @Test(arguments: BillPricingFixture.allNames)
    func deviceTimeZoneDoesNotChangeTheBill(name: String) throws {
        let fixture = try BillPricingFixture.load(name)
        let baseline = try Self.computeBill(fixture: fixture)

        let previous = TimeZone.ReferenceType.default
        let auckland = try #require(TimeZone(identifier: "Pacific/Auckland"))
        TimeZone.ReferenceType.default = auckland
        defer { TimeZone.ReferenceType.default = previous }

        let underAuckland = try Self.computeBill(fixture: fixture)
        #expect(underAuckland.periods == baseline.periods)
        #expect(abs(underAuckland.totalCost - baseline.totalCost) <= 1e-12)
    }

    @Test
    func uncoveredWindowPricesAsUnknown() throws {
        let fixture = try BillPricingFixture.load("uncovered-window")
        // `decompileTariffToSeasons` on the server currently merges uncovered gaps into OFF_PEAK when
        // serializing `timeline`, whereas `expected.currentBill` was priced against the 00:00-13:00 /
        // 14:00-24:00 schedule. Restore the 13:00-14:00 gap here to verify uncovered-window pricing.
        let gappedTimeline = Self.withGapFrom13To14(fixture.timeline)
        let resolver = try #require(RatePeriodResolver(timeline: gappedTimeline))

        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = try #require(TimeZone(identifier: gappedTimeline.timezone))
        let oneThirtyPm = try #require(cal.date(from: DateComponents(
            year: 2026,
            month: 6,
            day: 2,
            hour: 13,
            minute: 30
        )))
        #expect(resolver.period(at: oneThirtyPm) == .unknown)

        let buckets = BillUsageAggregator.buckets(
            days: fixture.days.map { $0.asEnergyFlowDay() },
            from: fixture.expected.currentBill.cycleStart,
            to: fixture.expected.currentBill.cycleEnd,
            resolver: resolver
        )
        let unknownBucket = try #require(buckets.first { $0.planName == "Unknown" && $0.periodName == "Unknown" })
        #expect(unknownBucket.buyRate == 0)
        #expect(unknownBucket.sellRate == 0)
        #expect(abs(unknownBucket.gridWh / 1000.0 - (-6.96)) <= 1e-9)

        let gappedFixture = BillPricingFixture(
            name: fixture.name,
            now: fixture.now,
            billingDay: fixture.billingDay,
            timeline: gappedTimeline,
            days: fixture.days,
            expected: fixture.expected
        )
        let computed = try Self.computeBill(fixture: gappedFixture)
        try Self.assertMatchesExpected(computed: computed, expected: fixture.expected.currentBill)
    }

    private static func withGapFrom13To14(_ timeline: SiteTariffsTimelineResponse) -> SiteTariffsTimelineResponse {
        let trimWindow: (TimePeriodWindowInput) -> TimePeriodWindowInput = { window in
            guard window.fromHour == 0, window.toHour == 14 else { return window }
            return TimePeriodWindowInput(
                touName: window.touName,
                fromHour: window.fromHour,
                fromMinute: window.fromMinute,
                toHour: 13,
                toMinute: 0,
                buyRate: window.buyRate,
                sellRate: window.sellRate
            )
        }
        return SiteTariffsTimelineResponse(
            version: timeline.version,
            siteId: timeline.siteId,
            timezone: timeline.timezone,
            currency: timeline.currency,
            periods: timeline.periods.map { period in
                TariffPeriodDTO(
                    periodId: period.periodId,
                    tariffId: period.tariffId,
                    name: period.name,
                    version: period.version,
                    source: period.source,
                    effectiveFrom: period.effectiveFrom,
                    effectiveTo: period.effectiveTo,
                    isCurrentToday: period.isCurrentToday,
                    updatedBy: period.updatedBy,
                    seasons: period.seasons.map { season in
                        TariffSeasonInput(
                            name: season.name,
                            fromMonth: season.fromMonth,
                            toMonth: season.toMonth,
                            weekdayPeriods: season.weekdayPeriods.map(trimWindow),
                            weekendPeriods: season.weekendPeriods.map(trimWindow),
                            fromDay: season.fromDay,
                            toDay: season.toDay
                        )
                    }
                )
            },
            reattribution: timeline.reattribution,
            holidayDates: timeline.holidayDates,
            teslaSync: timeline.teslaSync
        )
    }
}
