import SwiftUI

struct RatePlanEditorFlow: View {
    @Environment(\.dismiss) private var dismiss
    @State private var state: RatePlanEditorState
    @State private var expandedSeasonIDs: Set<UUID> = []
    @State private var isConfirmingDiscard = false

    init(
        mode: RatePlanEditorMode,
        timeZone: TimeZone,
        currency: String,
        takenNames: [String],
        onCreate: @escaping @MainActor (TariffPlanWriteRequest) async throws -> Void,
        onUpdate: @escaping @MainActor (Int, TariffPlanPatchRequest) async throws -> Void
    ) {
        _state = State(
            initialValue: RatePlanEditorState(
                mode: mode,
                timeZone: timeZone,
                currency: currency,
                takenNames: takenNames,
                onCreate: onCreate,
                onUpdate: onUpdate
            )
        )
    }

    var body: some View {
        NavigationStack(path: $state.path) {
            RatePlanSummaryScreen(
                state: state,
                expandedSeasonIDs: $expandedSeasonIDs,
                onDismiss: { dismiss() },
                onCancel: requestDismiss
            )
            .navigationDestination(for: RatePlanEditorRoute.self) { route in
                destinationView(for: route)
            }
        }
        .interactiveDismissDisabled(state.hasUnsavedChanges || state.isSaving)
        .background(SheetDismissAttemptObserver(onAttempt: requestDismiss))
        .confirmationDialog(
            "Discard changes to this rate plan?", isPresented: $isConfirmingDiscard, titleVisibility: .visible
        ) {
            Button("Discard Changes", role: .destructive) { dismiss() }
            Button("Keep Editing", role: .cancel) {}
        }
    }

    private func requestDismiss() {
        guard !state.isSaving else { return }
        if state.hasUnsavedChanges {
            isConfirmingDiscard = true
        } else {
            dismiss()
        }
    }

    @ViewBuilder
    private func destinationView(for route: RatePlanEditorRoute) -> some View {
        switch route {
        case .seasons(let isWizard):
            RatePlanSeasonsEditorView(
                state: state,
                isWizard: isWizard,
                onFinish: { state.finishStep(from: route) }
            )
        case .schedule(let seasonIndex, let dayGroup, let isWizard):
            RateScheduleEditorView(
                state: state,
                seasonIndex: seasonIndex,
                initialDayGroup: dayGroup,
                isWizard: isWizard,
                onFinish: { state.finishStep(from: route) }
            )
        case .pricing(let seasonIndex, let isWizard):
            RatePricingEditorView(
                state: state,
                seasonIndex: seasonIndex,
                isWizard: isWizard,
                onFinish: { state.finishStep(from: route) }
            )
        }
    }
}

private struct RatePlanSummaryScreen: View {
    @Bindable var state: RatePlanEditorState
    @Binding var expandedSeasonIDs: Set<UUID>
    let onDismiss: () -> Void
    let onCancel: () -> Void

    var body: some View {
        Form {
            problemSection
            nameSection
            datesSection
            seasonsSection
            impactSection
        }
        .navigationTitle(screenTitle)
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel).disabled(state.isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if state.isSaving {
                        ProgressView()
                    } else {
                        Button("Save", action: saveAction)
                            .fontWeight(.semibold)
                            .disabled(!state.canSubmit)
                    }
                }
            }
            .onAppear {
                if expandedSeasonIDs.isEmpty, let first = state.draft.seasons.first {
                    expandedSeasonIDs.insert(first.id)
                }
            }
    }

    private var screenTitle: String {
        switch state.mode {
        case .add: "New Rate Plan"
        case .copy: "Customize Rate Plan"
        case .edit: "Edit Rate Plan"
        }
    }

    /// At the top so a reason Save is unavailable (or a failed save) is never scrolled out of sight.
    @ViewBuilder
    private var problemSection: some View {
        if let message = state.saveError ?? state.validationError {
            Section {
                Label(message, systemImage: "exclamationmark.circle.fill")
                    .font(.subheadline)
                    .foregroundStyle(.red)
            } header: {
                Text(state.saveError != nil ? "Couldn't Save" : "Needs Attention")
            }
        }
    }

    private var nameSection: some View {
        Section {
            TextField("Rate plan name", text: $state.draft.name)
                .font(.headline)
        } header: {
            Text("Rate Plan Name")
        } footer: {
            if let problem = state.draft.nameProblem {
                Text(problem).foregroundStyle(.red)
            } else {
                Text("Each rate plan needs its own name.")
            }
        }
    }

    private var datesSection: some View {
        Section("Effective Dates") {
            DatePicker("Effective From", selection: fromDateBinding, displayedComponents: .date)
            Toggle("Ongoing (no end date)", isOn: $state.draft.isOngoing)
            if !state.draft.isOngoing {
                DatePicker("Effective To", selection: toDateBinding, displayedComponents: .date)
            }
        }
    }

    private var seasonsSection: some View {
        Section {
            ForEach(Array(state.draft.seasons.enumerated()), id: \.element.id) { index, season in
                SummarySeasonRow(
                    state: state,
                    seasonIndex: index,
                    season: season,
                    isExpanded: expandedBinding(for: season.id)
                )
            }
        } header: {
            HStack {
                Text("Seasons & Schedules")
                Spacer()
                Button("Edit Seasons") { state.openSeasons() }
                    .font(.subheadline.weight(.semibold))
            }
        }
    }

    private var impactSection: some View {
        Section {
            Text("Historical energy days covered by these dates will update in the background after saving.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func expandedBinding(for seasonID: UUID) -> Binding<Bool> {
        Binding(
            get: { expandedSeasonIDs.contains(seasonID) },
            set: { isOpen in
                if isOpen { expandedSeasonIDs.insert(seasonID) } else { expandedSeasonIDs.remove(seasonID) }
            }
        )
    }

    private var fromDateBinding: Binding<Date> {
        civilDateBinding(
            get: { state.draft.effectiveFrom },
            set: { state.draft.effectiveFrom = $0 }
        )
    }

    private var toDateBinding: Binding<Date> {
        civilDateBinding(
            get: { state.draft.effectiveTo },
            set: { state.draft.effectiveTo = $0 }
        )
    }

    private func civilDateBinding(get: @escaping () -> Date, set: @escaping (Date) -> Void) -> Binding<Date> {
        Binding(
            get: {
                let ymd = RatePlanTimelineFormatting.formatYMD(get(), in: state.draft.timeZone)
                return RatePlanTimelineFormatting.parseYMD(ymd, in: Calendar.current.timeZone) ?? get()
            },
            set: { picked in
                let ymd = RatePlanTimelineFormatting.formatYMD(picked, in: Calendar.current.timeZone)
                if let resolved = RatePlanTimelineFormatting.parseYMD(ymd, in: state.draft.timeZone) {
                    set(resolved)
                }
            }
        )
    }

    private func saveAction() {
        Task {
            let saved = await state.save()
            if saved { onDismiss() }
        }
    }
}

private struct SummarySeasonRow: View {
    let state: RatePlanEditorState
    let seasonIndex: Int
    let season: SeasonDraft
    @Binding var isExpanded: Bool

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                editLinkRow(
                    title: "Seasons",
                    detail: RatePlanTimelineFormatting.seasonMonthLabel(
                        fromMonth: season.fromMonth,
                        toMonth: season.toMonth
                    )
                ) { state.openSeasons() }
                editLinkRow(
                    title: "Weekday Schedule",
                    detail: "\(season.weekdayWindows.count) rate periods"
                ) { state.openSchedule(seasonIndex: seasonIndex, dayGroup: .weekdays) }
                editLinkRow(
                    title: "Weekend Schedule",
                    detail: season.sameScheduleAsWeekdays
                        ? "Same as weekdays"
                        : "\(season.weekendWindows.count) rate periods"
                ) { state.openSchedule(seasonIndex: seasonIndex, dayGroup: .weekends) }
                editLinkRow(
                    title: "Pricing",
                    detail: pricingPreview
                ) { state.openPricing(seasonIndex: seasonIndex) }
            }
            .padding(.vertical, 4)
        } label: {
            HStack {
                Text(season.name).font(.headline)
                Spacer()
                Text(RatePlanTimelineFormatting.seasonMonthLabel(fromMonth: season.fromMonth, toMonth: season.toMonth))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var pricingPreview: String {
        let count = Set(season.weekdayWindows.map(\.touName) + season.weekendWindows.map(\.touName)).count
        return "\(count) rate tiers"
    }

    private func editLinkRow(title: String, detail: String, action: @escaping () -> Void) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.medium))
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Edit", action: action)
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.borderless)
        }
    }
}
