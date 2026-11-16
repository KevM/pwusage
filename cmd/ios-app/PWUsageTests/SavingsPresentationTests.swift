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
                == "Your system saved about $142 this cycle"
        )

        let negative = SavingsFigures(
            costs: ScenarioCosts(recorded: 114, batteryFixed: 100, solarAlone: 100, noSolar: 100),
            daysWithData: 14,
            daysInPeriod: 14
        )
        #expect(
            SavingsPresentation.cycleHeadline(negative, currency: "USD", locale: Self.usLocale)
                == "Your system cost about $14 this cycle"
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

    @Test("Editing a fixed plan leaves its end date unchanged")
    func fixedPlanEditPreservesEndDate() {
        let request = FixedRatePlanDraft.makeWriteRequest(
            name: "Fixed", buyRate: 0.14, sellRate: 0.04, startsOn: .now, timeZone: .gmt
        )
        #expect(FixedRatePlanDraft.makePatchRequest(request).effectiveTo == .unchanged)
    }

    @Test("FixedRatePlanDraft formats and parses rates using the given locale")
    func fixedRatePlanDraftLocaleRates() {
        let german = Locale(identifier: "de_DE")
        #expect(FixedRatePlanDraft.formatRate(0.32, locale: german) == "0,32")
        #expect(FixedRatePlanDraft.parseRate("0,32", locale: german) == 0.32)
        #expect(FixedRatePlanDraft.parseRate("0,045", locale: german) == 0.045)
        #expect(FixedRatePlanDraft.parseRate("-0,10", locale: german) == nil)
        #expect(FixedRatePlanDraft.parseRate("", locale: german) == nil)

        #expect(FixedRatePlanDraft.formatRate(0.32, locale: Self.usLocale) == "0.32")
        #expect(FixedRatePlanDraft.parseRate("0.32", locale: Self.usLocale) == 0.32)
    }

    @Test("Fixed plan start explains earlier uncounted days")
    func fixedRatePlanStartCaveat() {
        let gap = SavingsCoverageGap(
            cause: .noFixedRatePlan, days: 31,
            ranges: [.init(first: "2026-10-01", last: "2026-10-31")], fixedRatePlanStart: "2026-11-01"
        )
        #expect(SavingsPresentation.caveats(figures([gap])) == [
            SavingsCaveat(
                text: "Your fixed rate plan starts Nov 1, 2026, so earlier days aren’t counted.",
                action: .editFixedRatePlan(suggestedStart: "2026-10-01")
            )
        ])
    }

    @Test("Rate plan gap describes the range")
    func ratePlanRangeCaveat() {
        let caveats = SavingsPresentation.caveats(figures([rateGap]))
        #expect(caveats == [SavingsCaveat(
            text: "We don’t have your rate plan for Mar 2 to Jun 30, 2024, so those days aren’t counted.",
            action: .fixRatePlans
        )])
        #expect(caveats.first?.actionTitle == "Fix Rate Plans")
        #expect(caveats.first?.id == "ratePlan")
    }

    @Test("Fixed gap after plan start uses range form")
    func fixedGapAfterPlanStartUsesRangeForm() {
        let gap = SavingsCoverageGap(
            cause: .noFixedRatePlan, days: 121, ranges: rateGap.ranges, fixedRatePlanStart: nil
        )
        let caveats = SavingsPresentation.caveats(figures([gap]))
        #expect(caveats == [SavingsCaveat(
            text: "We don’t have your fixed rate plan for Mar 2 to Jun 30, 2024, so those days aren’t counted.",
            action: .editFixedRatePlan(suggestedStart: nil)
        )])
        #expect(caveats.first?.actionTitle == "Edit Fixed Rate Plan")
        #expect(caveats.first?.id == "fixed")
    }

    @Test("Day ranges use single-day, cross-year and two-range forms")
    func dayRangesTextForms() {
        #expect(SavingsPresentation.dayRangesText([.init(first: "2024-03-02", last: "2024-03-02")], days: 1)
            == "Mar 2, 2024")
        #expect(SavingsPresentation.dayRangesText([.init(first: "2023-12-20", last: "2024-01-04")], days: 16)
            == "Dec 20, 2023 to Jan 4, 2024")
        #expect(SavingsPresentation.dayRangesText([
            .init(first: "2024-03-02", last: "2024-03-05"),
            .init(first: "2024-06-01", last: "2024-06-30")
        ], days: 34) == "Mar 2 to Mar 5, 2024 and Jun 1 to Jun 30, 2024")
    }

    @Test("Three or more ranges summarize by exact day count")
    func threeOrMoreRangesSummarizeAsDayCount() {
        #expect(SavingsPresentation.dayRangesText([
            .init(first: "2024-03-02", last: "2024-03-05"),
            .init(first: "2024-06-01", last: "2024-06-30"),
            .init(first: "2025-06-24", last: "2025-06-30")
        ], days: 41) == "41 days between Mar 2, 2024 and Jun 30, 2025")
    }

    @Test("Fixed plan caveat comes before rate plan caveat")
    func caveatsOrderFixedThenRatePlan() {
        let fixed = SavingsCoverageGap(
            cause: .noFixedRatePlan, days: 1, ranges: rateGap.ranges, fixedRatePlanStart: nil
        )
        #expect(SavingsPresentation.caveats(figures([rateGap, fixed])).map(\.id) == ["fixed", "ratePlan"])
    }

    @Test("No data alone gives no caveats")
    func noDataAloneGivesNoCaveats() {
        let gap = SavingsCoverageGap(cause: .noData, days: 1, ranges: rateGap.ranges, fixedRatePlanStart: nil)
        #expect(SavingsPresentation.caveats(figures([gap])).isEmpty)
    }

    @Test("Complete coverage gives no caveats")
    func completeCoverageGivesNoCaveats() {
        #expect(SavingsPresentation.caveats(figures([])).isEmpty)
    }

    @Test("Zero counted cycle shows fixable caveats, but not no-data alone")
    func zeroCountedCycleShowsCaveatsWithoutHeadline() {
        #expect(SavingsPresentation.showsCard(figures([rateGap])))
        let noData = SavingsCoverageGap(cause: .noData, days: 1, ranges: rateGap.ranges, fixedRatePlanStart: nil)
        #expect(!SavingsPresentation.showsCard(figures([noData])))
    }

    @Test("Counted days show the savings card")
    func showsCardForCountedDays() {
        let counted = SavingsFigures(costs: .zero, daysWithData: 1, daysInPeriod: 1)
        #expect(SavingsPresentation.showsCard(counted))
    }

    private var rateGap: SavingsCoverageGap {
        SavingsCoverageGap(
            cause: .noRatePlan, days: 121,
            ranges: [.init(first: "2024-03-02", last: "2024-06-30")], fixedRatePlanStart: nil
        )
    }

    private func figures(_ gaps: [SavingsCoverageGap]) -> SavingsFigures {
        SavingsFigures(costs: .zero, daysWithData: 0, daysInPeriod: 121, coverageGaps: gaps)
    }
}
