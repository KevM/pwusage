import Foundation
@testable import PWUsageCore
import Testing

@Suite(.serialized)
struct BillingCycleTests {
    @Test
    func billingDay31InFebruaryMatchesServer() throws {
        let fixture = try BillPricingFixture.load("billing-day-31-february")
        let siteZone = try #require(TimeZone(identifier: fixture.timeline.timezone))
        let cycle = BillingCycle.current(
            billingDay: fixture.billingDay,
            now: fixture.now,
            timeZone: siteZone
        )
        #expect(cycle.start == fixture.expected.currentBill.cycleStart)
        #expect(cycle.end == fixture.expected.currentBill.cycleEnd)
    }

    @Test
    func cycleBoundsUseSiteZoneNotDevice() throws {
        let siteZone = try #require(TimeZone(identifier: "America/Los_Angeles"))
        // 2026-02-01T06:30:00Z is 2026-01-31 22:30 PST (still in January in LA, already Feb 1 in UTC/Auckland).
        let formatter = ISO8601DateFormatter()
        let boundaryInstant = try #require(formatter.date(from: "2026-02-01T06:30:00Z"))

        let baseline = BillingCycle.current(billingDay: 1, now: boundaryInstant, timeZone: siteZone)

        let previous = TimeZone.ReferenceType.default
        let auckland = try #require(TimeZone(identifier: "Pacific/Auckland"))
        TimeZone.ReferenceType.default = auckland
        defer { TimeZone.ReferenceType.default = previous }

        let underAuckland = BillingCycle.current(billingDay: 1, now: boundaryInstant, timeZone: siteZone)
        #expect(underAuckland.start == baseline.start)
        #expect(underAuckland.end == baseline.end)

        var laCal = Calendar(identifier: .gregorian)
        laCal.timeZone = siteZone
        let expectedStart = try #require(laCal.date(from: DateComponents(year: 2026, month: 1, day: 1)))
        let expectedEnd = try #require(laCal.date(from: DateComponents(year: 2026, month: 2, day: 1)))
        #expect(underAuckland.start == expectedStart)
        #expect(underAuckland.end == expectedEnd)
    }

    @Test
    func cyclesSpanFromFirstDayThroughNow() throws {
        let siteZone = try #require(TimeZone(identifier: "America/Chicago"))
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = siteZone
        let from = try #require(cal.date(from: DateComponents(year: 2026, month: 1, day: 20)))
        let through = try #require(cal.date(from: DateComponents(year: 2026, month: 4, day: 10)))

        let cycles = BillingCycle.cycles(billingDay: 15, from: from, through: through, timeZone: siteZone)
        #expect(cycles.count == 3)
        #expect(cycles[0].start == cal.date(from: DateComponents(year: 2026, month: 1, day: 15)))
        #expect(cycles[0].end == cal.date(from: DateComponents(year: 2026, month: 2, day: 15)))
        #expect(cycles[1].start == cal.date(from: DateComponents(year: 2026, month: 2, day: 15)))
        #expect(cycles[2].start == cal.date(from: DateComponents(year: 2026, month: 3, day: 15)))
        #expect(cycles[2].end == cal.date(from: DateComponents(year: 2026, month: 4, day: 15)))
    }
}
