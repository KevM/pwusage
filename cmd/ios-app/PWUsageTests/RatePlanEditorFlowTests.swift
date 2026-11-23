import Foundation
@testable import PWUsage
import PWUsageCore
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
        #expect(state.draft.nameProblem == "Name this rate plan.")
        #expect(!state.canSubmit)

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
    @Test("Toolbar Save is available for new plans, and for existing plans only once edited")
    func toolbarSaveAvailability() throws {
        let timeZone = TimeZone(identifier: "America/Chicago") ?? .gmt
        let blank = RatePlanEditorState(mode: .add, timeZone: timeZone, currency: "USD", takenNames: ["Taken"])
        #expect(!blank.canSubmit) // needs a name
        blank.draft.name = "taken "
        #expect(blank.draft.nameProblem?.contains("already named") == true)
        #expect(!blank.canSubmit)
        blank.draft.name = "Fresh Plan"
        #expect(!blank.canSubmit, "A new plan has no dates until the owner picks them")
        blank.draft.effectiveFrom = Date(timeIntervalSince1970: 1_767_000_000)
        #expect(!blank.canSubmit)
        blank.draft.end = .ongoing
        #expect(blank.canSubmit)

        let timeline = try MobileContractDecoder.make().decode(
            SiteTariffsTimelineResponse.self,
            from: Data(TariffSheetTests.fixture.utf8)
        )
        let period = try #require(timeline.periods.first)
        let editing = RatePlanEditorState(mode: .edit(period), timeZone: timeZone, currency: "USD")
        #expect(!editing.canSubmit)
        // The fixture only covers Oct-Apr; completing the year is the edit that makes it valid.
        editing.draft.seasons[0].fromMonth = 1
        editing.draft.seasons[0].toMonth = 12
        #expect(editing.canSubmit)
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
        failingState.draft.effectiveFrom = Date(timeIntervalSince1970: 1_767_000_000)
        failingState.draft.end = .ongoing
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
        succeedingState.draft.effectiveFrom = Date(timeIntervalSince1970: 1_767_000_000)
        succeedingState.draft.end = .ongoing
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

    @MainActor
    @Test("Review needs both dates, and any later edit discards the review")
    func reviewNeedsDatesAndEditsInvalidate() async throws {
        let spy = try RatePlanReviewModelTests.Spy(preview: RatePlanReviewModelTests.preview())
        let state = RatePlanEditorState(
            mode: .copy(Self.samplePeriod), timeZone: .gmt, currency: "USD", selection: spy.actions
        )
        #expect(state.draft.effectiveFrom == nil, "Copying keeps the rates but never the dates")
        #expect(state.draft.end == nil)
        #expect(state.validationError == "Choose a start date.")
        #expect(!state.canReview)
        state.startReview()
        #expect(state.review == nil)

        state.draft.effectiveFrom = Date(timeIntervalSince1970: 1_767_225_600) // 2026-01-01 UTC
        #expect(state.validationError == "Choose an end date, or choose Ongoing.")
        #expect(!state.canReview, "Ongoing or an end date must be chosen too")
        state.draft.end = .endsOn(Date(timeIntervalSince1970: 1_767_139_200)) // 2025-12-31 UTC
        #expect(state.validationError == "Effective end date must be on or after the start date.")
        state.draft.end = .ongoing
        #expect(state.canReview)
        state.startReview()
        #expect(state.path == [.review])
        let review = try #require(state.review)
        #expect(review.request.effectiveFrom == "2026-01-01")
        #expect(review.request.effectiveTo == nil)
        guard case .manual(let name, _) = review.request.candidate else {
            Issue.record("Expected a manual candidate")
            return
        }
        #expect(name == "Summer Time-of-Use")

        state.draft.end = .endsOn(Date(timeIntervalSince1970: 1_769_817_600)) // 2026-01-31 UTC
        #expect(state.review == nil, "Changing the dates needs a fresh review")
        #expect(state.path.isEmpty)
        #expect(spy.previews.isEmpty, "Nothing was sent while the owner only edited and cancelled")
    }

    @MainActor
    @Test("Without reviewed selections on the server, Save still works and Review is unavailable")
    func olderServerKeepsSave() {
        let state = RatePlanEditorState(mode: .copy(Self.samplePeriod), timeZone: .gmt, currency: "USD")
        state.draft.effectiveFrom = Date(timeIntervalSince1970: 1_767_225_600)
        state.draft.end = .ongoing
        #expect(state.canSubmit)
        #expect(!state.canReview)
    }

    @MainActor
    @Test("A reviewed edit can extend a plan but not shorten it; Edit Dates handles that")
    func reviewedEditCannotShorten() throws {
        let spy = try RatePlanReviewModelTests.Spy(preview: RatePlanReviewModelTests.preview())
        let manual = TariffPeriodDTO(
            periodId: 99, tariffId: 7, name: "Manual Winter", version: 2, source: .manual,
            effectiveFrom: "2026-01-15", effectiveTo: nil, isCurrentToday: true, updatedBy: nil,
            seasons: Self.samplePeriod.seasons
        )
        let utc = TimeZone(identifier: "UTC") ?? .gmt
        let state = RatePlanEditorState(
            mode: .edit(manual), timeZone: utc, currency: "USD", selection: spy.actions
        )
        state.draft.name = "Renamed Winter"
        #expect(state.canReview)

        state.draft.end = .endsOn(RatePlanTimelineFormatting.parseYMD("2026-10-31", in: utc) ?? .now)
        #expect(!state.canReview)
        #expect(state.validationError == RatePlanEditorState.shortenedEditMessage)

        state.draft.end = .ongoing
        state.draft.effectiveFrom = RatePlanTimelineFormatting.parseYMD("2026-01-01", in: utc)
        #expect(state.canReview, "Starting earlier still covers the whole plan")
    }
}
