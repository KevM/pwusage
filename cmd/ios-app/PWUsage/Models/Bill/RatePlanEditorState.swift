import Foundation
import Observation

enum ScheduleDayGroup: String, Hashable, CaseIterable, Sendable {
    case weekdays
    case weekends

    var label: String {
        switch self {
        case .weekdays: "Weekdays (Mon – Fri)"
        case .weekends: "Weekends (Sat – Sun)"
        }
    }
}

enum RatePlanEditorRoute: Hashable, Sendable {
    case seasons(isWizard: Bool)
    case schedule(seasonIndex: Int, initialDayGroup: ScheduleDayGroup, isWizard: Bool)
    case pricing(seasonIndex: Int, isWizard: Bool)
}

@Observable
@MainActor
final class RatePlanEditorState {
    let mode: RatePlanEditorMode
    let currency: String
    var draft: RatePlanDraft
    private let initialDraft: RatePlanDraft
    var path: [RatePlanEditorRoute]
    var isSaving = false
    var saveError: String?

    private let onCreate: @MainActor (TariffPlanWriteRequest) async throws -> Void
    private let onUpdate: @MainActor (Int, TariffPlanPatchRequest) async throws -> Void

    init(
        mode: RatePlanEditorMode,
        timeZone: TimeZone,
        currency: String,
        onCreate: @escaping @MainActor (TariffPlanWriteRequest) async throws -> Void = { _ in },
        onUpdate: @escaping @MainActor (Int, TariffPlanPatchRequest) async throws -> Void = { _, _ in }
    ) {
        self.mode = mode
        self.currency = currency
        self.onCreate = onCreate
        self.onUpdate = onUpdate
        let initial: RatePlanDraft
        switch mode {
        case .add:
            initial = .makeBlank(timeZone: timeZone)
            path = [.seasons(isWizard: true)]
        case .copy(let period):
            initial = RatePlanDraft(copyingFrom: period, timeZone: timeZone)
            path = []
        case .edit(let period):
            initial = RatePlanDraft(editing: period, timeZone: timeZone)
            path = []
        }
        draft = initial
        initialDraft = initial
    }

    /// True once the user has changed anything, so a stray swipe cannot throw the work away.
    var hasUnsavedChanges: Bool { draft != initialDraft }

    var validationError: String? { draft.validate() }
    var canSave: Bool { validationError == nil && !isSaving }

    func finishStep(from route: RatePlanEditorRoute) {
        switch route {
        case .seasons(let isWizard):
            if isWizard {
                path.append(.schedule(seasonIndex: 0, initialDayGroup: .weekdays, isWizard: true))
            } else {
                path = []
            }
        case .schedule(let seasonIndex, _, let isWizard):
            if isWizard {
                path.append(.pricing(seasonIndex: seasonIndex, isWizard: true))
            } else {
                path = []
            }
        case .pricing(let seasonIndex, let isWizard):
            if isWizard, seasonIndex + 1 < draft.seasons.count {
                path.append(.schedule(seasonIndex: seasonIndex + 1, initialDayGroup: .weekdays, isWizard: true))
            } else {
                path = []
            }
        }
    }

    func openSeasons() {
        path = [.seasons(isWizard: false)]
    }

    func openSchedule(seasonIndex: Int, dayGroup: ScheduleDayGroup = .weekdays) {
        path = [.schedule(seasonIndex: seasonIndex, initialDayGroup: dayGroup, isWizard: false)]
    }

    func openPricing(seasonIndex: Int) {
        path = [.pricing(seasonIndex: seasonIndex, isWizard: false)]
    }

    func setSameScheduleAsWeekdays(_ enabled: Bool, seasonIndex: Int) {
        guard draft.seasons.indices.contains(seasonIndex) else { return }
        draft.seasons[seasonIndex].sameScheduleAsWeekdays = enabled
        if enabled {
            draft.seasons[seasonIndex].weekendWindows = draft.seasons[seasonIndex].weekdayWindows.map { window in
                DayPeriodDraft(
                    touName: window.touName,
                    startSlot: window.startSlot,
                    endSlot: window.endSlot,
                    buyRateText: window.buyRateText,
                    sellRateText: window.sellRateText
                )
            }
        }
    }

    func updateRate(
        seasonIndex: Int,
        touName: TariffPeriodName,
        buyRateText: String? = nil,
        sellRateText: String? = nil
    ) {
        guard draft.seasons.indices.contains(seasonIndex) else { return }
        applyRateUpdate(
            to: &draft.seasons[seasonIndex].weekdayWindows,
            touName: touName,
            buy: buyRateText,
            sell: sellRateText
        )
        applyRateUpdate(
            to: &draft.seasons[seasonIndex].weekendWindows,
            touName: touName,
            buy: buyRateText,
            sell: sellRateText
        )
    }

    func save() async -> Bool {
        saveError = nil
        if let message = draft.validate() {
            saveError = message
            return false
        }
        guard let writeRequest = draft.toWriteRequest() else {
            saveError = "Please check all rate plan fields before saving."
            return false
        }
        isSaving = true
        defer { isSaving = false }
        do {
            switch mode {
            case .add, .copy:
                try await onCreate(writeRequest)
            case .edit(let period):
                let patch = TariffPlanPatchRequest(
                    name: writeRequest.name,
                    effectiveFrom: writeRequest.effectiveFrom,
                    effectiveTo: .set(writeRequest.effectiveTo),
                    seasons: writeRequest.seasons
                )
                try await onUpdate(period.periodId, patch)
            }
            return true
        } catch {
            saveError = error.localizedDescription
            return false
        }
    }

    private func applyRateUpdate(
        to windows: inout [DayPeriodDraft],
        touName: TariffPeriodName,
        buy: String?,
        sell: String?
    ) {
        for index in windows.indices where windows[index].touName == touName {
            if let buy { windows[index].buyRateText = buy }
            if let sell { windows[index].sellRateText = sell }
        }
    }
}
