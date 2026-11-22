import Foundation
@testable import PWUsageCore
import Testing

struct NextCheaperPeriodTests {
    @Test
    func phrasesMatchServerAcrossMidnightAndDST() throws {
        let springFixture = try BillPricingFixture.load("dst-spring-forward")
        let springZone = try #require(TimeZone(identifier: springFixture.timeline.timezone))
        let springNow = springFixture.now // 2026-03-09T18:00:00.000Z (12 PM MDT)

        // Same day
        #expect(
            NextCheaperPeriod.formatRelativeStart(
                start: springNow.addingTimeInterval(4 * 3600),
                now: springNow,
                timeZone: springZone
            ) == "today at 4 PM"
        )
        // Across midnight to tomorrow
        #expect(
            NextCheaperPeriod.formatRelativeStart(
                start: springNow.addingTimeInterval(12 * 3600),
                now: springNow,
                timeZone: springZone
            ) == "tomorrow at 12 AM"
        )
        // 3 days out -> weekday name
        #expect(
            NextCheaperPeriod.formatRelativeStart(
                start: springNow.addingTimeInterval(3 * 24 * 3600),
                now: springNow,
                timeZone: springZone
            ) == "Thursday at 12 PM"
        )
        // 8 days out -> Month Day
        #expect(
            NextCheaperPeriod.formatRelativeStart(
                start: springNow.addingTimeInterval(8 * 24 * 3600),
                now: springNow,
                timeZone: springZone
            ) == "Mar 17 at 12 PM"
        )

        // DST fall-back fixture now: 2026-11-02T18:00:00.000Z (11 AM MST)
        try assertRelativePhrase(fixtureName: "dst-fall-back", offsetHours: 5, expected: "today at 4 PM")
        try assertRelativePhrase(fixtureName: "dst-fall-back", offsetHours: 13, expected: "tomorrow at 12 AM")

        // Holiday weekday fixture: 2024-07-06T18:00:00.000Z (Saturday 12 PM MDT) -> Monday at 4 PM
        try assertRelativePhrase(fixtureName: "holiday-weekday", offsetHours: 52, expected: "Monday at 4 PM")
    }

    private func assertRelativePhrase(
        fixtureName: String,
        offsetHours: TimeInterval,
        expected: String
    ) throws {
        let fixture = try BillPricingFixture.load(fixtureName)
        let zone = try #require(TimeZone(identifier: fixture.timeline.timezone))
        let phrase = NextCheaperPeriod.formatRelativeStart(
            start: fixture.now.addingTimeInterval(offsetHours * 3600),
            now: fixture.now,
            timeZone: zone
        )
        #expect(phrase == expected)
    }
}
