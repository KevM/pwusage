import Foundation
@testable import PWUsage
import Testing

@Suite("RatePlanDraft validation and editing math")
struct RatePlanDraftTests {
    @Test("Adding, moving, and removing seasons keeps all 12 months covered without gaps")
    func seasonsMaintainFullYearCoverage() {
        let chicago = TimeZone(identifier: "America/Chicago") ?? .gmt
        var draft = RatePlanDraft.makeBlank(timeZone: chicago)
        draft.name = "Utility Plan"
        #expect(draft.validate() == nil)

        draft.addSeason()
        #expect(draft.seasons.count == 2)
        #expect(draft.validate() == nil)

        // Wraparound winter (Oct - May) + summer (Jun - Sep)
        draft.seasons[0].fromMonth = 10
        draft.seasons[0].toMonth = 5
        draft.seasons[1].fromMonth = 6
        draft.seasons[1].toMonth = 9
        #expect(draft.validate() == nil)

        // Moving boundary shifts seamlessly without leaving gaps
        draft.moveSeasonBoundary(afterIndex: 0, toStartMonth: 5)
        #expect(draft.seasons[0].toMonth == 4)
        #expect(draft.seasons[1].fromMonth == 5)
        #expect(draft.validate() == nil)

        // Removing a season stretches neighbor back to 12 months
        draft.removeSeason(at: 1)
        #expect(draft.seasons.count == 1)
        #expect(draft.validate() == nil)
    }

    @Test("Schedule handles midnight wraparound, minimum 30-min window, and 5-decimal conversion")
    func scheduleHandlesWraparoundAndThirtyMinuteSnapping() {
        var season = SeasonDraft.makeDefault(name: "Summer", fromMonth: 6, toMonth: 9)
        season.weekdayWindows = [
            DayPeriodDraft(
                touName: .offPeak,
                startSlot: 40,
                endSlot: 16,
                buyRateText: "0.10279",
                sellRateText: "0.0329"
            ),
            DayPeriodDraft(
                touName: .onPeak,
                startSlot: 16,
                endSlot: 40,
                buyRateText: "0.30335",
                sellRateText: "0.04906"
            )
        ]
        #expect(season.validateWeekdaySlots() == nil)
        let input = season.toInput()
        #expect(input?.weekdayPeriods.first?.buyRate == 0.10279)
        #expect(input?.weekdayPeriods.last?.sellRate == 0.04906)

        // Moving boundary maintains coverage and prevents crossing neighbor
        season.movePeriodBoundary(afterIndex: 0, toSlot: 18, isWeekday: true)
        #expect(season.weekdayWindows[0].endSlot == 18)
        #expect(season.weekdayWindows[1].startSlot == 18)
        #expect(season.validateWeekdaySlots() == nil)

        // Adding and removing keeps valid 48-slot coverage
        season.addTimePeriod(isWeekday: true)
        #expect(season.weekdayWindows.count == 3)
        #expect(season.validateWeekdaySlots() == nil)
        season.removeTimePeriod(at: 1, isWeekday: true)
        #expect(season.weekdayWindows.count == 2)
        #expect(season.validateWeekdaySlots() == nil)
    }

    @Test("Copy preserves exact source rate plan name without appending year or copy suffix")
    func copyPreservesExactPlanName() throws {
        let timeline = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffSheetTests.fixture.utf8)
        )
        let source = try #require(timeline.periods.first)
        let draft = RatePlanDraft(
            copyingFrom: source,
            timeZone: TimeZone(identifier: timeline.timezone) ?? .gmt
        )
        #expect(draft.name == source.name)
        #expect(!draft.name.contains("Copy"))
    }
}
