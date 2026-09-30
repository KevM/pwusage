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
                    // Deliberately no `.textContentType`: the password AutoFill
                    // flow can offer to save the key into the user's iCloud
                    // Keychain, which would break the device-only guarantee that
                    // the Keychain item itself provides.
                    SecureField("Solcast API key", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(isWorking)
                    Button(isConnected ? "Replace key" : "Save key") {
                        Task { await saveKeyAndDiscover() }
                    }
                    .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking)
                    if isConnected {
                        Label("Connected on this device", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        // Array names are provider data we deliberately do not
                        // persist, so the selection is shown by ID until someone
                        // spends a request rediscovering it.
                        if !selectedResourceIDs.isEmpty {
                            Text("Selected: \(selectedResourceIDs.sorted().joined(separator: ", "))")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            Text("No arrays selected yet, so no forecast is requested.")
                                .font(.footnote)
                                .foregroundStyle(.orange)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Button("Discover arrays") {
                            Task { await discoverArrays() }
                        }
                        .disabled(isWorking)
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
                        // A configured connection makes discovery the only route
                        // back to the friendly array list, so it needs its own
                        // action rather than being a side effect of saving a key.
                        Text("Rediscovery spends one of this device's requests today.")
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
                            .disabled(isWorking)
                        }
                        Button("Save array selection") {
                            Task { await saveSelection(Array(selectedResourceIDs).sorted()) }
                        }
                        .disabled(selectedResourceIDs.isEmpty || selectedResourceIDs.count > 2 || isWorking)
                    }
                }

                if isConnected && allowsManualIDs {
                    Section("Manual Solar System IDs") {
                        Text("Use this when discovery is unavailable. Solar System IDs stay on this device.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                        TextField("Solar System 1 ID", text: $manualResourceID1)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .disabled(isWorking)
                        TextField("Solar System 2 ID (optional)", text: $manualResourceID2)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .disabled(isWorking)
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
                        Text("This device has made \(budget.totalAttempts) of \(SolarForecastStore.totalAttemptsPerUTCDay) attempts today (\(budget.automaticAttempts) automatic).")
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
                                    await applyStatus(error, operation: .disconnect)
                                }
                            }
                        }
                        .disabled(isWorking)
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
            }
        )
    }

    private func loadStatus() async {
        let credential = await coordinator.solarForecastCredential()
        isConnected = credential != nil
        allowsManualIDs = credential != nil
        let selection = (credential?.resourceIDs ?? []).sorted()
        selectedResourceIDs = Set(selection)
        // Mirror the saved selection into the manual fields so the current state
        // is visible and editable even before anyone rediscovers the array list.
        manualResourceID1 = selection.first ?? ""
        manualResourceID2 = selection.dropFirst().first ?? ""
        budget = await coordinator.solarForecastBudget()
    }

    private func discoverArrays() async {
        isWorking = true
        defer { isWorking = false }
        do {
            discoveredSites = try await coordinator.discoverSolarSites()
            allowsManualIDs = true
            statusMessage = discoveredSites.isEmpty
                ? "No solar systems were discovered. Enter one or two Solar System IDs manually."
                : "Choose the arrays that belong to this PWUsage site."
        } catch {
            await applyStatus(error, operation: .discovery)
        }
        budget = await coordinator.solarForecastBudget()
    }

    private func saveKeyAndDiscover() async {
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await coordinator.connectSolarForecast(apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines))
        } catch {
            await applyStatus(error, operation: .connection)
            budget = await coordinator.solarForecastBudget()
            return
        }
        isConnected = true
        allowsManualIDs = false
        apiKey = ""
        do {
            discoveredSites = try await coordinator.discoverSolarSites()
            allowsManualIDs = true
            statusMessage = discoveredSites.isEmpty
                ? "No solar systems were discovered. Enter one or two Solar System IDs manually."
                : "Choose the arrays that belong to this PWUsage site."
        } catch {
            await applyStatus(error, operation: .discovery)
        }
        budget = await coordinator.solarForecastBudget()
    }

    private func saveSelection(_ resourceIDs: [String]) async {
        guard (1...2).contains(resourceIDs.count), Set(resourceIDs).count == resourceIDs.count else {
            statusMessage = "Choose one or two different Solar System IDs."
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
            await applyStatus(error, operation: .selection)
        }
        budget = await coordinator.solarForecastBudget()
    }

    private func applyStatus(_ error: Error, operation: SolarForecastSettingsOperation) async {
        let hasCredential = await coordinator.solarForecastCredential() != nil
        let presentation = SolarForecastSettingsStatus.presentation(
            for: error,
            operation: operation,
            hasCredential: hasCredential
        )
        isConnected = presentation.isConnected
        allowsManualIDs = presentation.allowsManualIDs
        statusMessage = presentation.message
    }
}
