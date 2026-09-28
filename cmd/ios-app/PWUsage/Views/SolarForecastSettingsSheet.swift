import SwiftUI

struct SolarForecastSettingsSheet: View {
    @ObservedObject var coordinator: DashboardCoordinator
    @Environment(\.dismiss) private var dismiss

    @State private var apiKey = ""
    @State private var discoveredSites: [SolcastSite] = []
    @State private var selectedResourceIDs: Set<String> = []
    @State private var manualResourceID1 = ""
    @State private var manualResourceID2 = ""
    @State private var statusMessage: String?
    @State private var budget: SolarForecastBudget?
    @State private var isWorking = false
    @State private var isConnected = false
    @State private var allowsManualIDs = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    SecureField("Solcast API key", text: $apiKey)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: apiKey) { coordinator.solarForecastSettingsDidEdit() }
                    Button(isConnected ? "Replace key" : "Save key") {
                        Task { await saveKeyAndDiscover() }
                    }
                    .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking)
                    if isConnected {
                        Label("Connected on this device", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    }
                    if let statusMessage {
                        Text(statusMessage)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                if !discoveredSites.isEmpty {
                    Section("Solar arrays") {
                        Text("Select one or two arrays. Tags are shown only as hints.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        ForEach(discoveredSites, id: \.resourceID) { site in
                            Toggle(isOn: selectionBinding(for: site.resourceID)) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(site.name)
                                    if !site.tags.isEmpty {
                                        Text(site.tags.joined(separator: ", "))
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                        Button("Save array selection") {
                            Task { await saveSelection(Array(selectedResourceIDs).sorted()) }
                        }
                        .disabled(selectedResourceIDs.isEmpty || selectedResourceIDs.count > 2 || isWorking)
                    }
                }

                if isConnected && allowsManualIDs {
                    Section("Manual resource IDs") {
                        Text("Use this when discovery is unavailable. Resource IDs stay on this device.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        TextField("Array 1 resource ID", text: $manualResourceID1)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onChange(of: manualResourceID1) { coordinator.solarForecastSettingsDidEdit() }
                        TextField("Array 2 resource ID (optional)", text: $manualResourceID2)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onChange(of: manualResourceID2) { coordinator.solarForecastSettingsDidEdit() }
                        Button("Save manual IDs") {
                            let ids = [manualResourceID1, manualResourceID2]
                                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                                .filter { !$0.isEmpty }
                            Task { await saveSelection(ids) }
                        }
                        .disabled(manualResourceID1.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking)
                    }
                }

                Section("Request usage") {
                    if let budget {
                        Text("This device has made \(budget.totalAttempts) of 10 attempts today (\(budget.automaticAttempts) automatic).")
                    } else {
                        Text("Usage on this device will appear after a key is saved.")
                    }
                    Text("Other devices or apps may also use your Solcast account quota.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if isConnected {
                    Section {
                        Button("Disconnect Solar forecast", role: .destructive) {
                            Task {
                                isWorking = true
                                defer { isWorking = false }
                                do {
                                    try await coordinator.disconnectSolarForecast()
                                    isConnected = false
                                    allowsManualIDs = false
                                    apiKey = ""
                                    discoveredSites = []
                                    selectedResourceIDs = []
                                    statusMessage = "Disconnected. Load timing will use tariff and balance data."
                                } catch {
                                    applyStatus(error, operation: .disconnect)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Solar forecast")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .overlay {
                if isWorking { ProgressView().controlSize(.large) }
            }
            .task { await loadStatus() }
        }
    }

    private func selectionBinding(for resourceID: String) -> Binding<Bool> {
        Binding(
            get: { selectedResourceIDs.contains(resourceID) },
            set: { selected in
                if selected {
                    guard selectedResourceIDs.count < 2 else {
                        statusMessage = "Select at most two arrays."
                        return
                    }
                    selectedResourceIDs.insert(resourceID)
                } else {
                    selectedResourceIDs.remove(resourceID)
                }
                coordinator.solarForecastSettingsDidEdit()
            }
        )
    }

    private func loadStatus() async {
        let credential = await coordinator.solarForecastCredential()
        isConnected = credential != nil
        allowsManualIDs = credential != nil
        selectedResourceIDs = Set(credential?.resourceIDs ?? [])
        budget = await coordinator.solarForecastBudget()
    }

    private func saveKeyAndDiscover() async {
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await coordinator.connectSolarForecast(apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines))
            isConnected = true
            allowsManualIDs = false
            apiKey = ""
            discoveredSites = try await coordinator.discoverSolarSites()
            allowsManualIDs = true
            statusMessage = discoveredSites.isEmpty
                ? "No arrays were discovered. Enter one or two resource IDs manually."
                : "Choose the arrays that belong to this PWUsage site."
        } catch {
            applyStatus(error, operation: .discovery)
        }
        budget = await coordinator.solarForecastBudget()
    }

    private func saveSelection(_ resourceIDs: [String]) async {
        guard (1...2).contains(resourceIDs.count), Set(resourceIDs).count == resourceIDs.count else {
            statusMessage = "Choose one or two different resource IDs."
            return
        }
        isWorking = true
        defer { isWorking = false }
        do {
            try await coordinator.selectSolarArrays(resourceIDs)
            selectedResourceIDs = Set(resourceIDs)
            statusMessage = "Array selection saved on this device."
            await coordinator.loadTimingDetailAppeared()
        } catch {
            applyStatus(error, operation: .selection)
        }
        budget = await coordinator.solarForecastBudget()
    }

    private func applyStatus(_ error: Error, operation: SolarForecastSettingsOperation) {
        let presentation = SolarForecastSettingsStatus.presentation(
            for: error,
            operation: operation,
            hasCredential: isConnected
        )
        isConnected = presentation.isConnected
        allowsManualIDs = presentation.allowsManualIDs
        statusMessage = presentation.message
    }
}
