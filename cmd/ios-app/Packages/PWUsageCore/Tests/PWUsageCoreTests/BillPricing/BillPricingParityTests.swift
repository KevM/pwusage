import Foundation
@testable import PWUsageCore
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

    @Test(arguments: BillPricingFixture.allNames)
    func outlookPointsMatchServer(name: String) throws {
        let rawFixture = try BillPricingFixture.load(name)
        let timeline = name == "uncovered-window"
            ? Self.withGapFrom13To14(rawFixture.timeline)
            : rawFixture.timeline
        let resolver = try #require(RatePeriodResolver(timeline: timeline))
        let siteZone = try #require(TimeZone(identifier: timeline.timezone))
        let cycle = BillingCycle.current(
            billingDay: rawFixture.billingDay,
            now: rawFixture.now,
            timeZone: siteZone
        )
        let expected = try #require(rawFixture.expected.outlook)
        let history = try #require(BillOutlookHistoryBuilder.build(.init(
            days: rawFixture.days.map { $0.asEnergyFlowDay() },
            cycleStart: cycle.start,
            cycleEnd: cycle.end,
            now: rawFixture.now,
            resolver: resolver,
            timeZone: siteZone
        )))

        #expect(history.observedThrough == expected.observedThrough)
        #expect(history.complete == expected.complete)
        #expect(history.points.count == expected.points.count)

        for (actualPoint, expectedPoint) in zip(history.points, expected.points) {
            #expect(actualPoint.date == expectedPoint.date)
            #expect(actualPoint.complete == expectedPoint.complete)
            #expect(abs(actualPoint.estimatedCost - expectedPoint.estimatedCost) <= 1e-9)
            #expect(actualPoint.buckets.count == expectedPoint.buckets.count)
            for expectedBucket in expectedPoint.buckets {
                let actualBucket = try #require(actualPoint.buckets.first {
                    $0.tariffName == expectedBucket.tariffName
                        && $0.periodName == expectedBucket.periodName
                        && $0.buyRate == expectedBucket.buyRate
                        && $0.sellRate == expectedBucket.sellRate
                })
                #expect(abs(actualBucket.netGridKwh - expectedBucket.netGridKwh) <= 1e-9)
            }
        }
    }

    @Test(arguments: BillPricingFixture.allNames)
    func loadTimingMatchesServer(name: String) throws {
        let rawFixture = try BillPricingFixture.load(name)
        let timeline = name == "uncovered-window"
            ? Self.withGapFrom13To14(rawFixture.timeline)
            : rawFixture.timeline
        let resolver = try #require(RatePeriodResolver(timeline: timeline))
        let siteZone = try #require(TimeZone(identifier: timeline.timezone))
        let cycle = BillingCycle.current(
            billingDay: rawFixture.billingDay,
            now: rawFixture.now,
            timeZone: siteZone
        )
        let flowDays = rawFixture.days.map { $0.asEnergyFlowDay() }
        let buckets = BillUsageAggregator.buckets(
            days: flowDays,
            from: cycle.start,
            to: cycle.end,
            resolver: resolver
        )
        let costs = BillPricing.costs(buckets)
        let actual = LoadTimingCalculator.compute(
            buckets: buckets,
            costs: costs,
            resolver: resolver,
            now: rawFixture.now,
            timeZone: siteZone
        )

        guard let expected = rawFixture.expected.loadTiming else {
            #expect(actual == nil)
            return
        }
        let actualTiming = try #require(actual)
        #expect(actualTiming.hasTariff == expected.hasTariff)
        #expect(actualTiming.hasCycleData == expected.hasCycleData)
        #expect(actualTiming.activeIsCheapest == expected.activeIsCheapest)
        #expect(actualTiming.nextCheaperPhrase == expected.nextCheaperPhrase)
        #expect(actualTiming.nextStartPhraseByKey == expected.nextStartPhraseByKey)
        if let expectedNextCheaper = expected.nextCheaper {
            let actualNextCheaper = try #require(actualTiming.nextCheaper)
            #expect(actualNextCheaper.name == expectedNextCheaper.name)
            #expect(actualNextCheaper.phrase == expectedNextCheaper.phrase)
            #expect(abs(actualNextCheaper.marginalCost - expectedNextCheaper.marginalCost) <= 1e-9)
        } else {
            #expect(actualTiming.nextCheaper == nil)
        }
        try Self.assertPeriodsMatch(actual: actualTiming.periods, expected: expected.periods)
        try Self.assertPeriodsMatch(actual: actualTiming.pricingPeriods, expected: expected.pricingPeriods)
    }

    @Test(arguments: BillPricingFixture.allNames)
    func outlookTariffTimelineMatchesServer(name: String) throws {
        let rawFixture = try BillPricingFixture.load(name)
        let timeline = name == "uncovered-window"
            ? Self.withGapFrom13To14(rawFixture.timeline)
            : rawFixture.timeline
        let resolver = try #require(RatePeriodResolver(timeline: timeline))
        let siteZone = try #require(TimeZone(identifier: timeline.timezone))
        let cycle = BillingCycle.current(
            billingDay: rawFixture.billingDay,
            now: rawFixture.now,
            timeZone: siteZone
        )
        let history = BillOutlookHistoryBuilder.build(.init(
            days: rawFixture.days.map { $0.asEnergyFlowDay() },
            cycleStart: cycle.start,
            cycleEnd: cycle.end,
            now: rawFixture.now,
            resolver: resolver,
            timeZone: siteZone
        ))
        guard let expectedLoadTiming = rawFixture.expected.loadTiming else {
            #expect(history?.tariffTimeline ?? [] == [])
            return
        }
        let builtHistory = try #require(history)
        if name == "uncovered-window" {
            // Outlook uses requiredEnd = min(now, cycleEnd), so coverage stops at the 13:00 gap (>= now).
            #expect(builtHistory.tariffTimeline.count == 1)
            #expect(builtHistory.tariffTimeline[0].start == builtHistory.observedThrough)
            let sevenDaysOut = rawFixture.now.addingTimeInterval(7 * 24 * 3600)
            let loadTimingSegments = LoadTimingTimelineBuilder.segments(
                resolver: resolver,
                from: builtHistory.observedThrough,
                to: max(sevenDaysOut, cycle.end),
                requiredEnd: sevenDaysOut
            )
            #expect(loadTimingSegments.isEmpty)
            return
        }
        let expectedSegments = Self.sliceTimeline(
            expectedLoadTiming.tariffTimeline,
            from: builtHistory.observedThrough,
            to: cycle.end
        )
        #expect(builtHistory.tariffTimeline.count == expectedSegments.count)
        Self.assertTimelineSegmentsMatch(actual: builtHistory.tariffTimeline, expected: expectedSegments)
    }

    private static func assertTimelineSegmentsMatch(
        actual: [BillOutlookTariff],
        expected: [LoadTimingTariffSegment]
    ) {
        for (actualSegment, expectedSegment) in zip(actual, expected) {
            #expect(actualSegment.start == expectedSegment.start)
            #expect(actualSegment.end == expectedSegment.end)
            #expect(actualSegment.periodKey == expectedSegment.periodKey)
            #expect(actualSegment.name == expectedSegment.name)
            #expect(abs(actualSegment.buyRate - expectedSegment.buyRate) <= 1e-9)
            #expect(abs(actualSegment.sellRate - expectedSegment.sellRate) <= 1e-9)
            #expect(actualSegment.periodName == expectedSegment.name)
        }
    }

    private static func assertPeriodsMatch(
        actual: [LoadTimingPeriod],
        expected: [LoadTimingPeriod]
    ) throws {
        #expect(actual.count == expected.count)
        for expectedPeriod in expected {
            let actualPeriod = try #require(
                actual.first { $0.name == expectedPeriod.name },
                "Missing period \(expectedPeriod.name)"
            )
            #expect(actualPeriod.basis == expectedPeriod.basis)
            #expect(actualPeriod.isActive == expectedPeriod.isActive)
            #expect(actualPeriod.nextStartPhrase == expectedPeriod.nextStartPhrase)
            #expect(abs(actualPeriod.cycleNetExportKwh - expectedPeriod.cycleNetExportKwh) <= 1e-9)
            #expect(abs(actualPeriod.buyRate - expectedPeriod.buyRate) <= 1e-9)
            #expect(abs(actualPeriod.sellRate - expectedPeriod.sellRate) <= 1e-9)
            switch (actualPeriod.marginalCost, expectedPeriod.marginalCost) {
            case let (lhs?, rhs?):
                #expect(abs(lhs - rhs) <= 1e-9)
            case (nil, nil):
                break
            default:
                Issue.record("Mismatched marginalCost for \(expectedPeriod.name)")
            }
        }
    }

    private static func sliceTimeline(
        _ segments: [LoadTimingTariffSegment],
        from start: Date,
        to end: Date
    ) -> [LoadTimingTariffSegment] {
        segments.compactMap { segment in
            let clippedStart = max(segment.start, start)
            let clippedEnd = min(segment.end, end)
            guard clippedStart < clippedEnd else { return nil }
            return LoadTimingTariffSegment(
                start: clippedStart,
                end: clippedEnd,
                periodKey: segment.periodKey,
                name: segment.name,
                buyRate: segment.buyRate,
                sellRate: segment.sellRate
            )
        }
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
