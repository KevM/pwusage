import SwiftUI

/// Sheet for choosing the residential rate plan on the owner's utility bill. Its public rates price
/// days without a rate plan.
struct UtilityPlanPickerView: View {
    let utilityName: String
    let model: UtilityPlanPickerModel
    let onChangeUtility: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage = model.errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                Section {
                    Text("Choose the plan on your \(utilityName) bill. "
                        + "Its public rates price days without a rate plan, through today.")
                        .foregroundStyle(.secondary)
                }
                planSection
                Section {
                    Button("Change Utility", action: onChangeUtility)
                }
            }
            .disabled(model.isSaving)
            .navigationTitle("Your Rate Plan")
            .task { await model.load() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .onChange(of: model.isDone) { _, isDone in
                if isDone { dismiss() }
            }
        }
    }

    private var planSection: some View {
        Section {
            planRows
        } header: {
            Text("Residential plans")
        } footer: {
            Text("Not sure? The plan name is on your bill. Adding your rate plan in Rate Plans gives a better figure.")
        }
    }

    @ViewBuilder
    private var planRows: some View {
        switch model.state {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity)
        case .failed:
            Text("Couldn’t load rate plans for \(utilityName). Check your connection and try again.")
            Button("Try Again") {
                Task { await model.load() }
            }
        case .loaded(let plans):
            if plans.isEmpty {
                Text("No residential plans are listed for \(utilityName).")
            }
            ForEach(plans) { plan in
                Button {
                    Task { await model.select(plan) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(plan.name)
                        Text(UtilityPlanPickerModel.sinceLabel(for: plan))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

#Preview("Plans loaded") {
    UtilityPlanPickerView(
        utilityName: "Pacific Gas & Electric",
        model: UtilityPlanPickerModel(
            loadPlans: {
                [
                    UtilityPlanDTO(label: "rs-tou", name: "Residential TOU", startDate: "2026-01-01"),
                    UtilityPlanDTO(label: "rs-ev", name: "Residential EV", startDate: "2025-06-01")
                ]
            },
            selectPlan: { _ in }
        ),
        onChangeUtility: {}
    )
}

#Preview("Loading failed") {
    UtilityPlanPickerView(
        utilityName: "Pacific Gas & Electric",
        model: UtilityPlanPickerModel(
            loadPlans: { throw PreviewLoadError() },
            selectPlan: { _ in }
        ),
        onChangeUtility: {}
    )
}

private struct PreviewLoadError: Error {}
