import SwiftUI

/// Sheet for choosing the utility whose public rates estimate days without a rate plan.
struct UtilityPickerView: View {
    @Bindable var model: UtilityPickerModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                resultsSection
                skipSection
                if let errorMessage = model.errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .disabled(model.isSaving)
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
        }
    }

    private var resultsSection: some View {
        Section {
            ForEach(model.results, id: \.self) { name in
                Button(name) {
                    Task { await model.select(name) }
                }
            }
        } header: {
            Text("Your utility’s public rates fill days without a rate plan, so bills and savings can be estimated.")
        } footer: {
            Text("Utility names and rates come from the OpenEI Utility Rate Database. "
                + "Only the utility name is used; never your location.")
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

#Preview("Empty") {
    UtilityPickerView(
        model: UtilityPickerModel(
            search: { _ in [] },
            setUtility: { _ in },
            skipUtility: {}
        )
    )
}
