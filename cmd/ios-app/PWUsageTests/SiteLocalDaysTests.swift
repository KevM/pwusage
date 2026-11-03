import Foundation
@testable import PWUsage
import Testing

@Suite("Site-local days")
struct SiteLocalDaysTests {
    private let chicago = TimeZone(identifier: "America/Chicago") ?? .gmt

    @Test func stepsWholeCalendarDaysAcrossDaylightSaving() {
        #expect(SiteLocalDays.adding(1, to: "2026-10-31", timeZone: chicago) == "2026-11-01")
        #expect(SiteLocalDays.adding(1, to: "2026-11-01", timeZone: chicago) == "2026-11-02")
        #expect(SiteLocalDays.adding(-1, to: "2026-03-09", timeZone: chicago) == "2026-03-08")
        #expect(SiteLocalDays.days(from: "2026-03-07", to: "2026-03-10", timeZone: chicago) == 3)
        #expect(SiteLocalDays.adding(-365, to: "2026-11-02", timeZone: chicago) == "2025-11-02")
    }

    @Test func takesTodayInTheSiteTimeZone() {
        // 2026-11-02 03:00Z is still 11-01 in Chicago.
        #expect(SiteLocalDays.today(now: Date(timeIntervalSince1970: 1_793_588_400), timeZone: chicago) == "2026-11-01")
    }

    @Test func rejectsMalformedDays() {
        #expect(SiteLocalDays.adding(1, to: "2026-02-30", timeZone: chicago) == nil)
        #expect(SiteLocalDays.adding(1, to: "yesterday", timeZone: chicago) == nil)
    }
}
