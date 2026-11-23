import PWUsageCore
import SwiftUI

struct FixedRatePlanActions: Sendable {
    var selection: RatePlanSelectionActions?
    /// The guide's staging: the form hands back a manual choice instead of reviewing it.
    var stage: (@MainActor (FixedComparisonChoice) -> Void)?
    var onApplied: @MainActor (TariffSelectionCommitResponse, TariffSelectionRequest) -> Void = { _, _ in }
    var onDismiss: (@MainActor () -> Void)?
    /// Cancel returns to the picker that led here instead of closing everything.
    var onBack: (@MainActor () -> Void)?
}

/// Enter rates myself for one fixed comparison row: a flat price per kWh for exactly the row's dates,
/// which are fixed and not editable here. In Rate Plans it continues to the server's review; in the
/// history guide it stages the choice.
struct FixedRatePlanForm: View {
    let range: (from: String, to: String?)
    let currency: String
    let actions: FixedRatePlanActions

    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var buyRateText = ""
    @State private var sellRateText = FixedRatePlanDraft.formatRate(0)
    @State private var path: [Route] = []
    @State private var review: RatePlanReviewModel?

    private enum Route: Hashable { case review }

    var body: some View {
        NavigationStack(path: $path) {
            Form {
                detailsSection
                ratesSection
                if actions.selection != nil, !stagesChoice {
                    Section {
                        Text("Next, you’ll review exactly what changes before anything is saved.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle(FixedComparisonPresentation.pickerTitle)
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
                    Button("Cancel") { if let onBack = actions.onBack { onBack() } else { close() } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if stagesChoice {
                        Button(FixedComparisonPresentation.useRatesTitle) { stageChoice() }
                            .fontWeight(.semibold)
                            .disabled(!canSave)
                    } else {
                        Button("Review") { startReview() }
                            .fontWeight(.semibold)
                            .disabled(!canSave || actions.selection == nil)
                    }
                }
            }
        }
    }

    private var detailsSection: some View {
        Section {
            TextField(FixedRatePlanDraft.normalizedName(""), text: $name)
                .textInputAutocapitalization(.words)
            LabeledContent("Dates", value: RatePlanTimelineFormatting.displayRange(from: range.from, to: range.to))
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

    private var parsedBuyRate: Double? {
        FixedRatePlanDraft.parseRate(buyRateText)
    }

    private var parsedSellRate: Double? {
        let trimmed = sellRateText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return 0 }
        return FixedRatePlanDraft.parseRate(trimmed)
    }

    private var stagesChoice: Bool {
        actions.stage != nil
    }

    private var canSave: Bool {
        parsedBuyRate != nil && parsedSellRate != nil
    }

    private func stageChoice() {
        guard canSave, let stage = actions.stage, let buyRate = parsedBuyRate, let sellRate = parsedSellRate else {
            return
        }
        ManualLayoutKeyboard.dismiss()
        stage(.manual(name: FixedRatePlanDraft.normalizedName(name), buyRate: buyRate, sellRate: sellRate))
        close()
    }

    private func startReview() {
        guard canSave,
              let selection = actions.selection,
              let buyRate = parsedBuyRate,
              let sellRate = parsedSellRate else { return }
        ManualLayoutKeyboard.dismiss()
        let request = FixedRatePlanDraft.makeSelectionRequest(
            name: name, buyRate: buyRate, sellRate: sellRate, range: range
        )
        if review?.request != request {
            review = RatePlanReviewModel(request: request, actions: selection)
        }
        if path.last != .review {
            path.append(.review)
        }
    }

    private func close() {
        if let onDismiss = actions.onDismiss {
            onDismiss()
        } else {
            dismiss()
        }
    }
}

#Preview {
    FixedRatePlanForm(range: ("2026-01-01", "2026-03-31"), currency: "USD", actions: FixedRatePlanActions())
}
