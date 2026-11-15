import Foundation
@testable import PWUsage
import Testing

@Suite("Savings Presentation")
struct SavingsPresentationTests {
    private static let usLocale = Locale(identifier: "en_US")

    @Test("Headline uses about and currency, and switches to cost when negative")
    func headlineUsesAboutAndCurrency() {
        let positive = SavingsFigures(
            costs: ScenarioCosts(recorded: 100, batteryFixed: 130, solarAlone: 146, noSolar: 242),
            daysWithData: 14,
            daysInPeriod: 14
        )
        #expect(
            SavingsPresentation.cycleHeadline(positive, currency: "USD", locale: Self.usLocale)
                == "Your system saved about $142 this month"
        )

        let negative = SavingsFigures(
            costs: ScenarioCosts(recorded: 114, batteryFixed: 100, solarAlone: 100, noSolar: 100),
            daysWithData: 14,
            daysInPeriod: 14
        )
        #expect(
            SavingsPresentation.cycleHeadline(negative, currency: "USD", locale: Self.usLocale)
                == "Your system cost about $14 this month"
        )
    }

    @Test("Breakdown line matches fixed copy and preserves negative components")
    func breakdownLineMatchesCopy() {
        let figures = SavingsFigures(
            costs: ScenarioCosts(recorded: 100, batteryFixed: 130, solarAlone: 146, noSolar: 242),
            daysWithData: 14,
            daysInPeriod: 14
        )
        #expect(
            SavingsPresentation.breakdownLine(figures, currency: "USD", locale: Self.usLocale)
                == "Solar about $96 · Powerwall and your rate plan about $46"
        )

        let negativeRatePlan = SavingsFigures(
            costs: ScenarioCosts(recorded: 140, batteryFixed: 100, solarAlone: 100, noSolar: 200),
            daysWithData: 14,
            daysInPeriod: 14
        )
        #expect(
            SavingsPresentation.breakdownLine(negativeRatePlan, currency: "USD", locale: Self.usLocale)
                == "Solar about $100 · Powerwall and your rate plan about -$40"
        )
    }

    @Test("Coverage line formats day counts with grouping")
    func coverageLineFormatsCounts() {
        let figures = SavingsFigures(
            costs: .zero,
            daysWithData: 2_914,
            daysInPeriod: 2_950
        )
        #expect(
            SavingsPresentation.coverageLine(figures, locale: Self.usLocale)
                == "Based on 2,914 of 2,950 days"
        )
    }

    @Test("FixedRatePlanDraft builds an all-year, all-day season request")
    func fixedRatePlanFormBuildsAllDaySeason() throws {
        let zone = try #require(TimeZone(identifier: "America/Chicago"))
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        let startsOn = try #require(cal.date(from: DateComponents(year: 2024, month: 1, day: 1)))

        let request = FixedRatePlanDraft.makeWriteRequest(
            name: "Standard Fixed",
            buyRate: 0.14,
            sellRate: 0.04,
            startsOn: startsOn,
            timeZone: zone
        )

        #expect(request.name == "Standard Fixed")
        #expect(request.effectiveFrom == "2024-01-01")
        #expect(request.effectiveTo == nil)
        #expect(request.seasons.count == 1)

        let season = try #require(request.seasons.first)
        #expect(season.fromMonth == 1)
        #expect(season.toMonth == 12)
        let expectedWindow = TimePeriodWindowInput(
            touName: .offPeak,
            fromHour: 0,
            fromMinute: 0,
            toHour: 24,
            toMinute: 0,
            buyRate: 0.14,
            sellRate: 0.04
        )
        #expect(season.weekdayPeriods == [expectedWindow])
        #expect(season.weekendPeriods == [expectedWindow])
    }
}
