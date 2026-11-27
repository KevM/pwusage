import Foundation
import PWUsageCore
import Testing

@Suite("SiteTimeZone parity with Foundation.TimeZone")
struct SiteTimeZoneTests {
    private static func transitionTable(for identifier: String, from start: Date, to end: Date) throws -> SiteTimeZone {
        let timeZone = try #require(TimeZone(identifier: identifier))
        let initialOffset = timeZone.secondsFromGMT(for: start)
        var transitions: [SiteTimeZone.Transition] = []
        var cursor = start
        while let next = timeZone.nextDaylightSavingTimeTransition(after: cursor), next <= end {
            transitions.append(SiteTimeZone.Transition(
                atEpochSeconds: Int64(next.timeIntervalSince1970.rounded()),
                offsetSeconds: timeZone.secondsFromGMT(for: next)
            ))
            cursor = next
        }
        return SiteTimeZone(identifier: identifier, initialOffsetSeconds: initialOffset, transitions: transitions)
    }

    @Test(arguments: [
        "America/Los_Angeles",
        "America/New_York",
        "Australia/Adelaide",
        "America/Havana",
        "UTC"
    ])
    func matchesFoundationAcrossYearAndDST(_ identifier: String) throws {
        let start = Date(timeIntervalSince1970: 1_767_225_600) // 2026-01-01T00:00:00Z
        let end = Date(timeIntervalSince1970: 1_798_761_600) // 2027-01-01T00:00:00Z
        let native = SiteTimeZone(try #require(TimeZone(identifier: identifier)))
        let table = try Self.transitionTable(for: identifier, from: start.addingTimeInterval(-86_400 * 30),
                                             to: end.addingTimeInterval(86_400 * 30))

        // Sample every 6 hours across the entire year, including every DST boundary.
        var cursor = start
        while cursor < end {
            #expect(table.offsetSeconds(at: cursor) == native.offsetSeconds(at: cursor))
            #expect(table.localDayString(for: cursor) == native.localDayString(for: cursor))
            #expect(table.localHour(for: cursor) == native.localHour(for: cursor))
            #expect(table.localHourAndMinute(for: cursor) == native.localHourAndMinute(for: cursor))
            #expect(table.startOfDay(for: cursor) == native.startOfDay(for: cursor))
            #expect(table.startOfDay(addingDays: 2, to: cursor) == native.startOfDay(addingDays: 2, to: cursor))
            #expect(table.startOfDay(addingDays: -14, to: cursor) == native.startOfDay(addingDays: -14, to: cursor))
            cursor = cursor.addingTimeInterval(6 * 3600)
        }

        let probeA = Date(timeIntervalSince1970: 1_772_964_000) // 2026-03-08T10:00:00Z (US spring-forward)
        let probeB = Date(timeIntervalSince1970: 1_793_527_200) // 2026-11-01T10:00:00Z (US fall-back)
        #expect(table.calendarDays(from: probeA, to: probeB) == native.calendarDays(from: probeA, to: probeB))
        #expect(table.nextTransition(after: start) == native.nextTransition(after: start))
    }
}
