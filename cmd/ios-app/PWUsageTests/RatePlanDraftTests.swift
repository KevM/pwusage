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

        // Periods that wrap midnight are not edited in place: the boundary does not move.
        season.movePeriodBoundary(afterIndex: 0, toSlot: 18, isWeekday: true)
        #expect(season.weekdayWindows[0].endSlot == 16)
        #expect(season.weekdayWindows[1].startSlot == 16)
        #expect(season.validateWeekdaySlots() == nil)

        // Adding and removing keeps valid 48-slot coverage
        season.addTimePeriod(isWeekday: true)
        #expect(season.weekdayWindows.count == 3)
        #expect(season.validateWeekdaySlots() == nil)
        season.removeTimePeriod(at: 1, isWeekday: true)
        #expect(season.weekdayWindows.count == 2)
        #expect(season.validateWeekdaySlots() == nil)
    }

    @Test("Dragging a schedule boundary stops at the neighbouring boundary instead of overlapping")
    func boundaryDragClampsToAdjacentWindows() {
        func window(_ name: TariffPeriodName, _ start: Int, _ end: Int) -> DayPeriodDraft {
            DayPeriodDraft(touName: name, startSlot: start, endSlot: end, buyRateText: "0.1", sellRateText: "0.03")
        }
        var season = SeasonDraft.makeDefault(name: "Summer", fromMonth: 6, toMonth: 9)
        season.weekdayWindows = [window(.offPeak, 0, 12), window(.partialPeak, 12, 24), window(.onPeak, 24, 48)]

        // Past the middle window's end (slot 30 is inside the third window): stops at the neighbour.
        season.movePeriodBoundary(afterIndex: 0, toSlot: 30, isWeekday: true)
        #expect(season.validateWeekdaySlots() == nil)
        #expect(season.weekdayWindows[0].endSlot == 23)
        #expect(season.weekdayWindows[1].startSlot == 23)

        // Ordinary in-span drags still move freely.
        season.movePeriodBoundary(afterIndex: 0, toSlot: 6, isWeekday: true)
        #expect(season.weekdayWindows[0].endSlot == 6)
        #expect(season.validateWeekdaySlots() == nil)
    }

    @Test("Ending the lone all-day period early hands the rest of the day to a new period")
    func loneAllDayPeriodCanBeShortened() {
        var season = SeasonDraft.makeDefault(name: "Summer", fromMonth: 6, toMonth: 9)
        #expect(season.weekdayWindows.count == 1)

        season.movePeriodBoundary(afterIndex: 0, toSlot: 12, isWeekday: true)
        #expect(season.weekdayWindows.count == 2)
        #expect(season.weekdayWindows[0].startSlot == 0)
        #expect(season.weekdayWindows[0].endSlot == 12)
        #expect(season.weekdayWindows[1].startSlot == 12)
        #expect(season.weekdayWindows[1].endSlot == 48)
        #expect(season.validateWeekdaySlots() == nil)

        // Continue one period at a time: add, then edit the new period's end.
        season.addTimePeriod(isWeekday: true)
        #expect(season.weekdayWindows.count == 3)
        season.movePeriodBoundary(afterIndex: 1, toSlot: 36, isWeekday: true)
        #expect(season.weekdayWindows[1].endSlot == 36)
        #expect(season.validateWeekdaySlots() == nil)
    }

    @Test("Seasons get intuitive names as they are split, moved and merged, but typed names are kept")
    func seasonNamesFollowTheirMonths() {
        var draft = RatePlanDraft.makeBlank(timeZone: TimeZone(identifier: "America/Chicago") ?? .gmt)
        #expect(draft.seasons.map(\.name) == ["All year"])

        draft.addSeason()
        #expect(draft.seasons.map(\.name) == ["Winter", "Summer"])

        // Utility-style split: Summer Jun-Sep, Winter wraps Oct-May.
        draft.seasons[0].fromMonth = 10
        draft.seasons[0].toMonth = 5
        draft.seasons[1].fromMonth = 6
        draft.seasons[1].toMonth = 9
        draft.moveSeasonBoundary(afterIndex: 0, toStartMonth: 6)
        #expect(draft.seasons.map(\.name) == ["Winter", "Summer"])

        draft.removeSeason(at: 1)
        #expect(draft.seasons.map(\.name) == ["All year"])

        draft.addSeason()
        draft.seasons[0].name = "Peak Demand"
        draft.moveSeasonBoundary(afterIndex: 0, toStartMonth: 7)
        #expect(draft.seasons[0].name == "Peak Demand")
    }

    @Test("Editing periods one at a time never wraps a period past midnight")
    func periodsNeverWrapMidnight() {
        var season = SeasonDraft.makeDefault(name: "Summer", fromMonth: 6, toMonth: 9)
        season.movePeriodBoundary(afterIndex: 0, toSlot: 16, isWeekday: true) // Off-peak until 8 AM

        // The last period ends at midnight and has no movable end, so +30m cannot wrap it.
        season.movePeriodBoundary(afterIndex: 1, toSlot: 49, isWeekday: true)
        #expect(season.weekdayWindows.map(\.startSlot) == [0, 16])
        #expect(season.weekdayWindows.map(\.endSlot) == [16, 48])

        // Stepping the first boundary up and back down restores the original split exactly.
        season.movePeriodBoundary(afterIndex: 0, toSlot: 17, isWeekday: true)
        season.movePeriodBoundary(afterIndex: 0, toSlot: 16, isWeekday: true)
        #expect(season.weekdayWindows.map(\.endSlot) == [16, 48])

        // A boundary stops one slot short of the end of the next period.
        season.movePeriodBoundary(afterIndex: 0, toSlot: 99, isWeekday: true)
        #expect(season.weekdayWindows.map(\.endSlot) == [47, 48])
        #expect(season.weekdayWindows.allSatisfy { $0.startSlot < $0.endSlot })
    }

    @Test("A period that wraps midnight is split in two when the editor opens")
    func wrappingPeriodsSplitAtMidnight() {
        func input(_ name: TariffPeriodName, _ fromHour: Int, _ toHour: Int) -> TimePeriodWindowInput {
            TimePeriodWindowInput(
                touName: name, fromHour: fromHour, fromMinute: 0, toHour: toHour, toMinute: 0,
                buyRate: 0.1, sellRate: 0.03
            )
        }
        let loaded = SeasonDraft(from: TariffSeasonInput(
            name: "Summer", fromMonth: 6, toMonth: 9,
            weekdayPeriods: [input(.offPeak, 20, 4), input(.onPeak, 4, 20)],
            weekendPeriods: [input(.offPeak, 0, 24)]
        ))
        #expect(loaded.weekdayWindows.map(\.startSlot) == [0, 8, 40])
        #expect(loaded.weekdayWindows.map(\.endSlot) == [8, 40, 48])
        #expect(loaded.weekdayWindows.map(\.touName) == [.offPeak, .onPeak, .offPeak])
        #expect(loaded.validateWeekdaySlots() == nil)
        #expect(loaded.toInput()?.weekdayPeriods.count == 3)
    }

    @Test("Adding a period after Peak defaults to Off-Peak, and Mid-Peak is Tesla's name")
    func addedPeriodDefaultsFollowPeak() {
        var season = SeasonDraft.makeDefault(name: "Summer", fromMonth: 6, toMonth: 9)
        season.movePeriodBoundary(afterIndex: 0, toSlot: 16, isWeekday: true)
        #expect(season.weekdayWindows.map(\.touName) == [.offPeak, .onPeak])
        season.addTimePeriod(isWeekday: true) // splits the longer Peak period
        #expect(season.weekdayWindows.map(\.touName) == [.offPeak, .onPeak, .offPeak])
        #expect(TariffPeriodName.partialPeak.displayName == "Mid-Peak")
        let names = TariffPeriodName.allCases.map(\.displayName)
        #expect(names == ["Super Off-Peak", "Off-Peak", "Mid-Peak", "Peak"])
    }

    @Test("Dragging a season boundary stops at the adjacent seasons' combined span")
    func seasonBoundaryClampsToNeighbours() {
        var draft = RatePlanDraft.makeBlank(timeZone: TimeZone(identifier: "America/Chicago") ?? .gmt)
        draft.name = "Plan"
        draft.seasons = [
            SeasonDraft.makeDefault(name: "A", fromMonth: 1, toMonth: 4),
            SeasonDraft.makeDefault(name: "B", fromMonth: 5, toMonth: 8),
            SeasonDraft.makeDefault(name: "C", fromMonth: 9, toMonth: 12)
        ]
        #expect(draft.validate() == nil)

        // October is inside season C: the boundary stops at the end of season B instead.
        draft.moveSeasonBoundary(afterIndex: 0, toStartMonth: 10)
        #expect(draft.seasons.map(\.fromMonth) == [1, 8, 9])
        #expect(draft.seasons.map(\.toMonth) == [7, 8, 12])
        #expect(draft.validate() == nil)

        // Ordinary moves inside the span still work.
        draft.moveSeasonBoundary(afterIndex: 0, toStartMonth: 4)
        #expect(draft.seasons.map(\.fromMonth) == [1, 4, 9])
        #expect(draft.validate() == nil)
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
