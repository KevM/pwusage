import SwiftUI

struct RatePlanEditorFlow: View {
    @Environment(\.dismiss) private var dismiss
    @State private var state: RatePlanEditorState
    @State private var expandedSeasonIDs: Set<UUID> = []

    init(
        mode: RatePlanEditorMode,
        timeZone: TimeZone,
        currency: String,
        onCreate: @escaping @MainActor (TariffPlanWriteRequest) async throws -> Void,
        onUpdate: @escaping @MainActor (Int, TariffPlanPatchRequest) async throws -> Void
    ) {
        _state = State(
            initialValue: RatePlanEditorState(
                mode: mode,
                timeZone: timeZone,
                currency: currency,
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
                onDismiss: { dismiss() }
            )
            .navigationDestination(for: RatePlanEditorRoute.self) { route in
                destinationView(for: route)
            }
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

    var body: some View {
        Form {
            nameSection
            datesSection
            seasonsSection
            impactSection
            saveButtonSection
        }
        .navigationTitle(screenTitle)
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onDismiss).disabled(state.isSaving)
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

    private var nameSection: some View {
        Section {
            TextField("Utility Rate Plan", text: $state.draft.name)
                .font(.headline)
        } header: {
            Text("Rate Plan Name")
        } footer: {
            Text("If left blank, this plan saves as \"Utility Rate Plan\".")
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
                    .font(.caption.weight(.semibold))
            }
        }
    }

    private var impactSection: some View {
        Section {
            Text("Historical energy days covered by these dates will update in the background after saving.")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let message = state.saveError ?? state.validationError {
                Text(message).font(.caption).foregroundStyle(.red)
            }
        }
    }

    private var saveButtonSection: some View {
        Section {
            Button {
                saveAction()
            } label: {
                HStack {
                    Spacer()
                    if state.isSaving {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Save Rate Plan").font(.headline)
                    }
                    Spacer()
                }
            }
            .disabled(!state.canSave)
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
                Text(season.name).font(.subheadline.weight(.semibold))
                Spacer()
                Text(RatePlanTimelineFormatting.seasonMonthLabel(fromMonth: season.fromMonth, toMonth: season.toMonth))
                    .font(.caption)
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
                Text(title).font(.caption.weight(.medium))
                Text(detail).font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Edit", action: action)
                .font(.caption.weight(.semibold))
                .buttonStyle(.borderless)
        }
    }
}
