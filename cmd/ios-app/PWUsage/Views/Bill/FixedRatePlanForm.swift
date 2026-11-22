import SwiftUI

struct FixedRatePlanActions: Sendable {
    var save: @MainActor (TariffPlanWriteRequest, TariffPeriodDTO?) async -> String?
    var delete: (@MainActor (Int) async -> String?)?
    var updateDates: (@MainActor (Int, TariffPlanPatchRequest) async throws -> Void)?
    var selection: RatePlanSelectionActions?
    var onApplied: @MainActor (TariffSelectionCommitResponse, TariffSelectionRequest) -> Void = { _, _ in }
    var onDismiss: (@MainActor () -> Void)?

    @MainActor static func live(
        _ coordinator: DashboardCoordinator,
        onDismiss: (@MainActor () -> Void)? = nil
    ) -> Self {
        Self(
            save: { request, editing in
                await coordinator.saveFixedRatePlan(request, editing: editing)
            },
            delete: { periodID in
                await coordinator.removeFixedRatePlan(periodID: periodID)
            },
            updateDates: { periodID, patch in
                let timeline = try await coordinator.updateReferenceRatePlan(periodID: periodID, body: patch)
                await coordinator.refreshSavings(timeline: timeline)
            },
            selection: coordinator.savingsTimeline?.supportsRatePlanSelection == true
                ? TariffTimelineActions.live(coordinator).selection
                : nil,
            onDismiss: onDismiss
        )
    }
}

/// Sheet for adding or editing the flat-rate reference plan used to compute savings.
struct FixedRatePlanForm: View {
    let existing: TariffPeriodDTO?
    let defaultStartDate: String?
    let suggestedStartDate: String?
    /// How far back an estimated plan's unbroken run of revisions reaches; see
    /// `RateEstimatesPresentation.fixedPlanEstimateCoverageNote`.
    let estimateCoverageNote: String?
    let timeZone: TimeZone
    let currency: String
    let actions: FixedRatePlanActions

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var buyRateText: String
    @State private var sellRateText: String
    @State private var startsOn: Date
    @State private var operation: Operation?
    @State private var errorMessage: String?
    @State private var path: [Route] = []
    @State private var review: RatePlanReviewModel?
    @State private var isEditingDates = false

    /// The write in flight; Save and Delete never run together.
    private enum Operation { case saving, deleting }
    private enum Route: Hashable { case review }

    init(
        existing: TariffPeriodDTO? = nil,
        defaultStartDate: String? = nil,
        suggestedStartDate: String? = nil,
        estimateCoverageNote: String? = nil,
        timeZone: TimeZone,
        currency: String,
        actions: FixedRatePlanActions
    ) {
        self.existing = existing
        self.defaultStartDate = defaultStartDate
        self.suggestedStartDate = suggestedStartDate
        self.estimateCoverageNote = estimateCoverageNote
        self.timeZone = timeZone
        self.currency = currency
        self.actions = actions

        let window = existing?.seasons.first?.weekdayPeriods.first
        _name = State(initialValue: existing?.name ?? "Fixed Rate Plan")
        _buyRateText = State(initialValue: window.map { FixedRatePlanDraft.formatRate($0.buyRate) } ?? "")
        _sellRateText = State(
            initialValue: window.map { FixedRatePlanDraft.formatRate($0.sellRate) } ?? FixedRatePlanDraft.formatRate(0)
        )
        _startsOn = State(
            initialValue: Self.parseDate(existing?.effectiveFrom ?? defaultStartDate, timeZone: timeZone) ?? Date()
        )
    }

    var body: some View {
        NavigationStack(path: $path) {
            Form {
                detailsSection
                ratesSection
                if actions.selection != nil {
                    Section {
                        Text("Next, you’ll review exactly what changes before anything is saved.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                if let existing, existing.source != .estimated, actions.delete != nil {
                    deleteSection(periodID: existing.periodId)
                }
            }
            .navigationTitle(existing == nil ? "Add Fixed Rate Plan" : "Edit Fixed Rate Plan")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .review:
                    if let review {
                        RatePlanReviewView(model: review) { response, request in
                            actions.onApplied(response, request)
                            close()
                        }
                    }
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { close() }
                        .disabled(operation != nil)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if actions.selection != nil {
                        Button("Review") { startReview() }
                            .fontWeight(.semibold)
                            .disabled(!canSave || operation != nil)
                    } else {
                        ToolbarBusyButton(
                            title: "Save", busyTitle: "Saving",
                            isBusy: operation == .saving, isEnabled: canSave && operation == nil
                        ) {
                            Task { await submit() }
                        }
                    }
                }
            }
            .sheet(isPresented: $isEditingDates) {
                if let existing, let updateDates = actions.updateDates {
                    EffectiveDatesSheet(period: existing) { periodID, patch in
                        try await updateDates(periodID, patch)
                        close()
                    }
                }
            }
        }
    }

    private var detailsSection: some View {
        Section {
            if existing?.source == .estimated {
                Text("Estimated")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.orange)
                if let estimateCoverageNote {
                    Text(estimateCoverageNote)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            TextField("Plan name", text: $name)
                .textInputAutocapitalization(.words)
            RatePlanDateField(
                title: "Starts on", date: $startsOn,
                boundary: suggestedStartDate == nil ? .first : nil, timeZone: timeZone
            )
            if let suggestedStartDate,
               let date = Self.parseDate(suggestedStartDate, timeZone: timeZone),
               RatePlanTimelineFormatting.formatYMD(startsOn, in: timeZone) != suggestedStartDate {
                Button("Start on \(RatePlanTimelineFormatting.displayDate(suggestedStartDate))") { startsOn = date }
            }
            if let editRangeProblem {
                Label(editRangeProblem, systemImage: "exclamationmark.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            if existing != nil, actions.selection != nil, actions.updateDates != nil {
                Button("Edit Dates", systemImage: "calendar") {
                    isEditingDates = true
                }
                .disabled(operation != nil)
            }
        } footer: {
            Text("This is the flat rate you would pay without solar or your current rate plan.")
        }
    }

    private var ratesSection: some View {
        Section("Rates (\(currency) per kWh)") {
            HStack {
                Text("Price per kWh")
                Spacer()
                TextField("0.32", text: $buyRateText)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 120)
            }
            HStack {
                Text("Export credit per kWh")
                Spacer()
                TextField("0.00", text: $sellRateText)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 120)
            }
        }
    }

    private func deleteSection(periodID: Int) -> some View {
        Section {
            Button(role: .destructive) {
                Task { await deletePlan(periodID: periodID) }
            } label: {
                BusyRowLabel(isBusy: operation == .deleting) { Text("Delete Fixed Rate Plan") }
            }
            .disabled(operation != nil)
        }
    }

    private var parsedBuyRate: Double? {
        FixedRatePlanDraft.parseRate(buyRateText)
    }

    private var parsedSellRate: Double? {
        let trimmed = sellRateText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return 0 }
        return FixedRatePlanDraft.parseRate(trimmed)
    }

    private var editRangeProblem: String? {
        FixedRatePlanDraft.editRangeProblem(
            existing: existing,
            startsOn: startsOn,
            timeZone: timeZone,
            usesSelection: actions.selection != nil
        )
    }

    private var canSave: Bool {
        parsedBuyRate != nil && parsedSellRate != nil && editRangeProblem == nil
    }

    private func startReview() {
        guard canSave,
              let selection = actions.selection,
              let buyRate = parsedBuyRate,
              let sellRate = parsedSellRate else { return }
        ManualLayoutKeyboard.dismiss()
        let request = FixedRatePlanDraft.makeSelectionRequest(
            name: name,
            buyRate: buyRate,
            sellRate: sellRate,
            startsOn: startsOn,
            effectiveTo: existing?.effectiveTo,
            timeZone: timeZone
        )
        if review?.request != request {
            review = RatePlanReviewModel(request: request, actions: selection)
        }
        if path.last != .review {
            path.append(.review)
        }
    }

    private func submit() async {
        guard let buyRate = parsedBuyRate, let sellRate = parsedSellRate else { return }
        // Resign the text field before sheet dismissal starts: letting UIKit call endEditing
        // inside dismissViewControllerAnimated can trigger a UISheetPresentationController
        // keyboard-frame layout loop in SwiftUI's AttributeGraph.
        ManualLayoutKeyboard.dismiss()
        operation = .saving
        errorMessage = nil
        let request = FixedRatePlanDraft.makeWriteRequest(
            name: name,
            buyRate: buyRate,
            sellRate: sellRate,
            startsOn: startsOn,
            timeZone: timeZone
        )
        let error = await actions.save(request, existing)
        operation = nil
        if let error {
            errorMessage = error
        } else {
            close()
        }
    }

    private func deletePlan(periodID: Int) async {
        guard let onDelete = actions.delete else { return }
        operation = .deleting
        errorMessage = nil
        let error = await onDelete(periodID)
        operation = nil
        if let error {
            errorMessage = error
        } else {
            close()
        }
    }

    private func close() {
        if let onDismiss = actions.onDismiss {
            onDismiss()
        } else {
            dismiss()
        }
    }

    private static func parseDate(_ raw: String?, timeZone: TimeZone) -> Date? {
        guard let raw else { return nil }
        let parts = raw.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }
}

#Preview {
    FixedRatePlanForm(
        timeZone: TimeZone(identifier: "America/Los_Angeles") ?? .current,
        currency: "USD",
        actions: FixedRatePlanActions(save: { _, _ in nil })
    )
}
