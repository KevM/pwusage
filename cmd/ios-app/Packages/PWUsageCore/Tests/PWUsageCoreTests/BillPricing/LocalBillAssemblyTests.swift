import Foundation
@testable import PWUsageCore
import Testing

@Suite("Local bill assembly")
struct LocalBillAssemblyTests {
    @Test("Assembles the bill, outlook, and load timing from fixture flows")
    func assemblesFromFlows() throws {
        let fixture = try BillPricingFixture.load("single-plan-cycle")
        let timeZone = try #require(TimeZone(identifier: fixture.timeline.timezone))
        let resolver = try #require(RatePeriodResolver(timeline: fixture.timeline))
        let cycle = BillingCycle.current(billingDay: fixture.billingDay, now: fixture.now, timeZone: timeZone)
        let assembly = LocalBillAssembly.compute(
            days: fixture.days.map { $0.asEnergyFlowDay() },
            cycle: cycle,
            resolver: resolver,
            now: fixture.now,
            timeZone: timeZone
        )

        let expectedBill = fixture.expected.currentBill
        #expect(cycle.start == expectedBill.cycleStart)
        #expect(cycle.end == expectedBill.cycleEnd)
        let actualCost = try #require(assembly.estimatedCost)
        let expectedCost = try #require(expectedBill.estimatedCost)
        #expect(abs(actualCost - expectedCost) <= 1e-9)
        #expect(assembly.periods.count == expectedBill.periods.count)
        for expectedPeriod in expectedBill.periods {
            let actual = try #require(assembly.periods.first {
                $0.tariffName == expectedPeriod.tariffName && $0.periodName == expectedPeriod.periodName
            })
            #expect(abs(actual.netGridKwh - expectedPeriod.netGridKwh) <= 1e-9)
            #expect(abs(actual.cost - expectedPeriod.cost) <= 1e-9)
        }

        try assertOutlook(assembly, matches: fixture)
        try assertLoadTiming(assembly, matches: fixture)
    }

    private func assertOutlook(_ assembly: LocalBillAssembly, matches fixture: BillPricingFixture) throws {
        let expected = try #require(fixture.expected.outlook)
        let actual = try #require(assembly.outlook)
        #expect(actual.observedThrough == expected.observedThrough)
        #expect(actual.complete == expected.complete)
        #expect(actual.points.count == expected.points.count)
        #expect(assembly.energyDataThrough == expected.observedThrough.addingTimeInterval(-300))
    }

    private func assertLoadTiming(_ assembly: LocalBillAssembly, matches fixture: BillPricingFixture) throws {
        let expected = try #require(fixture.expected.loadTiming)
        let actual = try #require(assembly.loadTiming)
        #expect(actual.hasTariff == expected.hasTariff)
        #expect(actual.hasCycleData == expected.hasCycleData)
        #expect(actual.activeIsCheapest == expected.activeIsCheapest)
        #expect(actual.periods.count == expected.periods.count)
        #expect(actual.pricingPeriods.count == expected.pricingPeriods.count)
        #expect(actual.nextCheaper?.name == expected.nextCheaper?.name)
        #expect(actual.tariffTimeline.count == expected.tariffTimeline.count)
    }
}
