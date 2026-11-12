import Foundation
@testable import PWUsage
import Testing

@Suite("RatePlanEditorFlow state and wizard navigation")
struct RatePlanEditorFlowTests {
    private static let samplePeriod = TariffPeriodDTO(
        periodId: 42,
        tariffId: 7,
        name: "Summer Time-of-Use",
        version: 1,
        source: .tesla,
        effectiveFrom: "2026-06-01",
        effectiveTo: nil,
        isCurrentToday: true,
        updatedBy: nil,
        seasons: [
            TariffSeasonInput(
                name: "Summer",
                fromMonth: 1,
                toMonth: 12,
                weekdayPeriods: [
                    TimePeriodWindowInput(
                        touName: .offPeak,
                        fromHour: 0,
                        fromMinute: 0,
                        toHour: 16,
                        toMinute: 0,
                        buyRate: 0.12,
                        sellRate: 0.03
                    ),
                    TimePeriodWindowInput(
                        touName: .onPeak,
                        fromHour: 16,
                        fromMinute: 0,
                        toHour: 24,
                        toMinute: 0,
                        buyRate: 0.34,
                        sellRate: 0.08
                    )
                ],
                weekendPeriods: [
                    TimePeriodWindowInput(
                        touName: .offPeak,
                        fromHour: 0,
                        fromMinute: 0,
                        toHour: 24,
                        toMinute: 0,
                        buyRate: 0.12,
                        sellRate: 0.03
                    )
                ]
            )
        ]
    )

    @MainActor
    @Test("New blank plan walks Seasons -> Schedule -> Pricing -> Summary wizard order")
    func blankPlanWalksWizardSteps() {
        let state = RatePlanEditorState(
            mode: .add,
            timeZone: TimeZone(identifier: "America/Chicago") ?? .gmt,
            currency: "USD"
        )
        #expect(state.path == [.seasons(isWizard: true)])
        #expect(state.draft.name.isEmpty)
        #expect(state.draft.effectiveName == "Utility Rate Plan")

        state.finishStep(from: .seasons(isWizard: true))
        let expectedScheduleRoute: RatePlanEditorRoute = .schedule(
            seasonIndex: 0,
            initialDayGroup: .weekdays,
            isWizard: true
        )
        #expect(state.path == [.seasons(isWizard: true), expectedScheduleRoute])

        state.finishStep(from: .schedule(seasonIndex: 0, initialDayGroup: .weekdays, isWizard: true))
        #expect(state.path.last == .pricing(seasonIndex: 0, isWizard: true))

        state.finishStep(from: .pricing(seasonIndex: 0, isWizard: true))
        #expect(state.path.isEmpty)
    }

    @MainActor
    @Test("Editor reports unsaved changes only after the draft differs from where it started")
    func tracksUnsavedChanges() {
        let state = RatePlanEditorState(
            mode: .add,
            timeZone: TimeZone(identifier: "America/Chicago") ?? .gmt,
            currency: "USD"
        )
        #expect(!state.hasUnsavedChanges)
        state.draft.name = "My Plan"
        #expect(state.hasUnsavedChanges)
        state.draft.name = ""
        #expect(!state.hasUnsavedChanges)
    }

    @MainActor
    @Test("Wizard starts the next season from the previous season's schedule when it is still blank")
    func nextSeasonStartsFromPreviousSchedule() {
        let state = RatePlanEditorState(
            mode: .add,
            timeZone: TimeZone(identifier: "America/Chicago") ?? .gmt,
            currency: "USD"
        )
        state.draft.addSeason()
        state.draft.seasons[0].movePeriodBoundary(afterIndex: 0, toSlot: 12, isWeekday: true)
        state.draft.seasons[0].weekdayWindows[1].buyRateText = "0.30"

        state.finishStep(from: .pricing(seasonIndex: 0, isWizard: true))

        let copied = state.draft.seasons[1].weekdayWindows
        #expect(copied.count == 2)
        #expect(copied[1].buyRateText == "0.30")
        #expect(copied.map(\.id) != state.draft.seasons[0].weekdayWindows.map(\.id))
    }

    @MainActor
    @Test("Copy starts on Summary with exact source name and supports direct Summary -> Edit -> Summary jumps")
    func copyStartsOnSummaryWithDirectJumps() {
        let state = RatePlanEditorState(
            mode: .copy(Self.samplePeriod),
            timeZone: TimeZone(identifier: "America/Chicago") ?? .gmt,
            currency: "USD"
        )
        #expect(state.path.isEmpty)
        #expect(state.draft.name == "Summer Time-of-Use")

        state.openSeasons()
        #expect(state.path == [.seasons(isWizard: false)])
        state.finishStep(from: .seasons(isWizard: false))
        #expect(state.path.isEmpty)

        state.openSchedule(seasonIndex: 0, dayGroup: .weekends)
        #expect(state.path == [.schedule(seasonIndex: 0, initialDayGroup: .weekends, isWizard: false)])
        state.finishStep(from: .schedule(seasonIndex: 0, initialDayGroup: .weekends, isWizard: false))
        #expect(state.path.isEmpty)

        state.openPricing(seasonIndex: 0)
        #expect(state.path == [.pricing(seasonIndex: 0, isWizard: false)])
        state.finishStep(from: .pricing(seasonIndex: 0, isWizard: false))
        #expect(state.path.isEmpty)
    }

    @MainActor
    @Test("Same schedule as weekdays toggle copies and unlinks weekend periods")
    func sameScheduleToggleCopiesAndUnlinks() {
        let state = RatePlanEditorState(
            mode: .copy(Self.samplePeriod),
            timeZone: .gmt,
            currency: "USD"
        )
        #expect(state.draft.seasons[0].sameScheduleAsWeekdays == false)

        state.setSameScheduleAsWeekdays(true, seasonIndex: 0)
        #expect(state.draft.seasons[0].sameScheduleAsWeekdays == true)
        #expect(state.draft.seasons[0].weekendWindows.count == state.draft.seasons[0].weekdayWindows.count)

        state.setSameScheduleAsWeekdays(false, seasonIndex: 0)
        state.draft.seasons[0].weekendWindows[0].touName = .superOffPeak
        #expect(state.draft.seasons[0].weekdayWindows[0].touName == .offPeak)
    }

    @MainActor
    @Test("Save preserves user edits on failure and persists exact rates on success")
    func saveHandlesErrorsAndPersistsSuccess() async {
        enum SampleError: LocalizedError {
            case rejected
            var errorDescription: String? { "Overlapping rate period." }
        }

        var capturedWrite: TariffPlanWriteRequest?
        let failingState = RatePlanEditorState(
            mode: .add,
            timeZone: TimeZone(identifier: "America/Chicago") ?? .gmt,
            currency: "USD",
            onCreate: { _ in throw SampleError.rejected },
            onUpdate: { _, _ in }
        )
        failingState.draft.name = "My Edited Plan"
        failingState.updateRate(
            seasonIndex: 0,
            touName: .offPeak,
            buyRateText: "0.145",
            sellRateText: "0.045"
        )

        let failedResult = await failingState.save()
        #expect(failedResult == false)
        #expect(failingState.saveError == "Overlapping rate period.")
        #expect(failingState.draft.name == "My Edited Plan")

        let succeedingState = RatePlanEditorState(
            mode: .add,
            timeZone: TimeZone(identifier: "America/Chicago") ?? .gmt,
            currency: "USD",
            onCreate: { request in capturedWrite = request },
            onUpdate: { _, _ in }
        )
        succeedingState.draft.name = "My Edited Plan"
        succeedingState.updateRate(
            seasonIndex: 0,
            touName: .offPeak,
            buyRateText: "0.145",
            sellRateText: "0.045"
        )

        let successResult = await succeedingState.save()
        #expect(successResult == true)
        #expect(succeedingState.saveError == nil)
        #expect(capturedWrite?.name == "My Edited Plan")
        #expect(capturedWrite?.seasons.first?.weekdayPeriods.first?.buyRate == 0.145)
        #expect(capturedWrite?.seasons.first?.weekdayPeriods.first?.sellRate == 0.045)
    }

    @MainActor
    @Test("Editing manual period dispatches patch request with preserved effectiveFrom")
    func editingPeriodDispatchesPatch() async {
        var patchedPeriodID: Int?
        var patchedBody: TariffPlanPatchRequest?
        let manualPeriod = TariffPeriodDTO(
            periodId: 99,
            tariffId: 7,
            name: "Manual Winter",
            version: 2,
            source: .manual,
            effectiveFrom: "2026-01-15",
            effectiveTo: "2026-04-30",
            isCurrentToday: false,
            updatedBy: nil,
            seasons: Self.samplePeriod.seasons
        )

        let state = RatePlanEditorState(
            mode: .edit(manualPeriod),
            timeZone: TimeZone(identifier: "America/Chicago") ?? .gmt,
            currency: "USD",
            onCreate: { _ in },
            onUpdate: { periodID, patch in
                patchedPeriodID = periodID
                patchedBody = patch
            }
        )
        state.draft.name = "Updated Winter"

        let saved = await state.save()
        #expect(saved == true)
        #expect(patchedPeriodID == 99)
        #expect(patchedBody?.name == "Updated Winter")
        #expect(patchedBody?.effectiveFrom == "2026-01-15")
        #expect(patchedBody?.effectiveTo == .set("2026-04-30"))
    }
}
