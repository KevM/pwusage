import SwiftUI

/// Sheet for the owner to say which country their home is in, when the saved home location
/// can't settle it. Public utility rates only cover US homes.
struct SiteCountryPickerView: View {
    @Bindable var model: SiteCountryPickerModel
    var onPublicPlansAvailable: () -> Void = {}
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
                if !model.suggestions.isEmpty, model.query.isEmpty {
                    Section("Near Your Home") {
                        rows(model.suggestions)
                    }
                }
                Section {
                    rows(model.countries)
                } header: {
                    Text("Public utility rates are available for US homes. Your choice is used only for that.")
                } footer: {
                    Text("Your home’s location stays on this iPhone; only the country you choose is saved.")
                }
            }
            .allowsHitTesting(!model.isSaving)
            .navigationTitle("Your Home’s Country")
            .searchable(text: $model.query, prompt: "Search countries")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { await model.load() }
            .onChange(of: model.outcome) { _, outcome in
                switch outcome {
                case .publicPlansAvailable: onPublicPlansAvailable()
                case .done: dismiss()
                case nil: break
                }
            }
        }
    }

    private func rows(_ options: [SiteCountryOption]) -> some View {
        ForEach(options) { option in
            Button {
                Task { await model.select(option) }
            } label: {
                HStack {
                    Text(option.name)
                        .foregroundStyle(.primary)
                    Spacer(minLength: 8)
                    if model.savingCode == option.code {
                        ProgressView()
                    }
                }
            }
        }
    }
}

#Preview("Near a border") {
    SiteCountryPickerView(model: SiteCountryPickerModel(
        inference: { .nearBorder(candidates: ["US", "CA"]) },
        save: { _ in throw CancellationError() }
    ))
}
