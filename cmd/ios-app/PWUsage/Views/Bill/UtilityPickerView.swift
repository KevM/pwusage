import SwiftUI

/// Sheet for choosing the utility whose public rates estimate days without a rate plan.
struct UtilityPickerView: View {
    @Bindable var model: UtilityPickerModel
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
                resultsSection
                skipSection
            }
            // Blocks taps without dimming, so the chosen row's spinner and check stay readable.
            .allowsHitTesting(!model.isSaving)
            .navigationTitle("Your Utility")
            .searchable(text: $model.query, prompt: "Search utilities")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .onChange(of: model.isDone) { _, isDone in
                if isDone { dismiss() }
            }
            .onDisappear { model.cancelSearch() }
        }
    }

    private var resultsSection: some View {
        Section {
            resultRows
        } header: {
            Text("Your utility’s public rates fill days without a rate plan, so bills and savings can be estimated.")
        } footer: {
            Text("Utility names and rates come from the OpenEI Utility Rate Database, which covers US homes. "
                + "Only the utility name is sent; never your location.")
        }
    }

    @ViewBuilder
    private var resultRows: some View {
        switch model.searchState {
        case .idle:
            EmptyView()
        case .results(let names):
            ForEach(names, id: \.self) { name in
                Button {
                    Task { await model.select(name) }
                } label: {
                    HStack {
                        Text(name)
                        Spacer(minLength: 8)
                        PickerChoiceMark(choice: model.choice, id: name)
                    }
                }
                .accessibilityAddTraits(model.choice?.id == name ? .isSelected : [])
            }
        case .empty(let query):
            Text("No utilities match “\(query)”.")
                .foregroundStyle(.secondary)
        case .failed:
            Text(UtilityPickerModel.searchFailureMessage)
                .foregroundStyle(.secondary)
        }
    }

    private var skipSection: some View {
        Section {
            Button("My Utility Isn’t Listed") {
                Task { await model.skip() }
            }
        } footer: {
            Text("Rate plans stay as they are. You can choose a utility later in Rate Plans.")
        }
    }
}

#Preview("Searching") {
    let model = UtilityPickerModel(
        search: { _ in ["Pacific Gas & Electric", "Pacific Power", "PacifiCorp"] },
        setUtility: { _ in },
        skipUtility: {}
    )
    model.query = "pac"
    return UtilityPickerView(model: model)
}

#Preview("No matches") {
    let model = UtilityPickerModel(
        debounce: .milliseconds(1),
        search: { _ in [] },
        setUtility: { _ in },
        skipUtility: {}
    )
    model.query = "zzz"
    return UtilityPickerView(model: model)
}
