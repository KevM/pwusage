import PWUsageCore
import SwiftUI

private enum FixedComparisonChangeRoute: Hashable {
    case review
}

/// Change on a fixed comparison row in the rate plan editor: pick a fixed plan, review the server's
/// change for exactly the row's dates, apply. Entering rates myself opens the form with the dates
/// locked and reviews the same way.
struct FixedComparisonChangeFlow: View {
    @State private var model: FixedComparisonChangeModel
    @State private var path: [FixedComparisonChangeRoute] = []
    let currency: String
    let utilityName: String?
    let actions: TariffTimelineActions
    let onApplied: @MainActor (TariffSelectionCommitResponse, TariffSelectionRequest) -> Void
    @Environment(\.dismiss) private var dismiss

    init(
        row: FixedComparisonRow,
        timeline: SiteTariffsTimelineResponse?,
        actions: TariffTimelineActions,
        onApplied: @escaping @MainActor (TariffSelectionCommitResponse, TariffSelectionRequest) -> Void
    ) {
        _model = State(initialValue: FixedComparisonChangeModel(
            row: row, selection: actions.selection, loadPlans: actions.publicPlans
        ))
        currency = timeline?.currency ?? "USD"
        utilityName = timeline?.estimates?.utilityName
        self.actions = actions
        self.onApplied = onApplied
    }

    var body: some View {
        Group {
            switch model.state {
            case .enteringRates:
                FixedRatePlanForm(
                    range: model.lockedRange,
                    currency: currency,
                    actions: FixedRatePlanActions(
                        selection: actions.selection,
                        onApplied: onApplied,
                        onBack: { if !model.backToPicker() { dismiss() } }
                    )
                )
            case .loading, .choosing, .failed:
                picker
            }
        }
        .task { if model.state == .loading { await model.load() } }
    }

    private var picker: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle(FixedComparisonPresentation.pickerTitle)
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
                .navigationDestination(for: FixedComparisonChangeRoute.self) { _ in
                    if let review = model.review {
                        RatePlanReviewView(model: review) { response, request in
                            onApplied(response, request)
                            dismiss()
                        }
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .choosing(let options):
            FixedComparisonPicker(
                options: options, currency: currency, utilityName: utilityName,
                onChoose: { option in
                    model.startReview(label: option.label)
                    path = [.review]
                },
                onEnterRates: { model.enterRates() }
            )
        case .failed(let message):
            Form {
                Section { Text(message).foregroundStyle(.secondary) }
                Section {
                    Button(RatePlanHistoryPresentation.retryTitle) { Task { await model.load() } }
                    Button(FixedComparisonPresentation.enterRatesTitle) { model.enterRates() }
                }
            }
        case .loading, .enteringRates:
            ProgressView(FixedComparisonPresentation.loadingPlans)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// Change on a plan in the guide's review: the year's fixed plans, or Enter rates myself. A choice only
/// stages the comparison on the flow; nothing is sent until Save Rate Plans.
struct FixedComparisonGuideChange: View {
    let options: [FixedComparisonOption]
    let range: (from: String, to: String?)
    let currency: String
    let utilityName: String?
    let onChoose: @MainActor (FixedComparisonChoice) -> Void
    @State private var entersRates: Bool
    @Environment(\.dismiss) private var dismiss

    init(
        options: [FixedComparisonOption],
        range: (from: String, to: String?),
        currency: String,
        utilityName: String?,
        onChoose: @escaping @MainActor (FixedComparisonChoice) -> Void
    ) {
        self.options = options
        self.range = range
        self.currency = currency
        self.utilityName = utilityName
        self.onChoose = onChoose
        _entersRates = State(initialValue: options.isEmpty)
    }

    var body: some View {
        if entersRates {
            FixedRatePlanForm(range: range, currency: currency, actions: FixedRatePlanActions(
                stage: onChoose,
                onBack: { if options.isEmpty { dismiss() } else { entersRates = false } }
            ))
        } else {
            NavigationStack {
                FixedComparisonPicker(
                    options: options, currency: currency, utilityName: utilityName,
                    onChoose: { option in
                        onChoose(option.choice)
                        dismiss()
                    },
                    onEnterRates: { entersRates = true }
                )
                .navigationTitle(FixedComparisonPresentation.pickerTitle)
                #if os(iOS)
                    .navigationBarTitleDisplayMode(.inline)
                #endif
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { dismiss() }
                        }
                    }
            }
        }
    }
}
