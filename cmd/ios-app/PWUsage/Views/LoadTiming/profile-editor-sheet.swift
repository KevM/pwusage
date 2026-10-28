import SwiftUI

struct ProfileEditorSheet: View {
    @State var draft: ProfileDraft
    let original: ProfileDraft
    let onCancel: () -> Void
    let onSave: (ProfileDraft) -> Void
    @FocusState var nameFocused: Bool
    @State var isConfirmingDiscard = false

    init(draft: ProfileDraft, onCancel: @escaping () -> Void, onSave: @escaping (ProfileDraft) -> Void) {
        _draft = State(initialValue: draft)
        original = draft
        self.onCancel = onCancel
        self.onSave = onSave
    }

    var hasUnsavedChanges: Bool { draft.hasUnsavedChanges(from: original) }

    /// Cancel and a swipe down both end here, so neither discards edits silently.
    func requestDismiss() {
        if hasUnsavedChanges {
            isConfirmingDiscard = true
        } else {
            onCancel()
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if draft.kind == .custom {
                    Section("Name") {
                        TextField("Bake bread", text: $draft.name)
                            .textContentType(.name)
                            .focused($nameFocused)
                            .accessibilityLabel("Custom job name")
                    }
                } else {
                    Section("Job Details") {
                        LabeledContent("Job Name", value: draft.name)
                    }
                }

                if draft.kind == .car, let settings = draft.carSettings {
                    Section("Car") {
                        decimalStepper("Battery capacity", value: carValue(\.capacityKwh), range: 1 ... LoadProfile.maximumCarCapacityKwh, step: 1, unit: "kWh")
                        decimalStepper("Current charge", value: carValue(\.initialStateOfCharge), range: 0 ... 100, step: 1, unit: "%")
                        decimalStepper("Target charge", value: carValue(\.targetStateOfCharge), range: settings.initialStateOfCharge ... 100, step: 1, unit: "%")
                        Picker("Charging level", selection: carLevelBinding) {
                            Text("Level 1").tag(CarChargingLevel.level1)
                            Text("Level 2").tag(CarChargingLevel.level2)
                        }
                        .accessibilityLabel("Charging level")
                    }
                }

                if draft.kind != .car {
                    Section("Job Estimate") {
                        decimalStepper("Energy", value: $draft.energyKwh, range: 0.1 ... 500, step: 0.5, unit: "kWh")
                        decimalStepper("Duration", value: $draft.durationHours, range: 0.1 ... 48, step: 0.5, unit: "hours")
                    }
                } else {
                    Section {
                        Text(carEstimateSummary)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .navigationTitle(draft.id == nil ? "New Custom Job" : "Edit Job")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: requestDismiss)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        nameFocused = false
                        onSave(draft)
                    }
                    .disabled(!draft.isValid)
                }
            }
            .onChange(of: draft.carSettings?.initialStateOfCharge) { _, current in
                guard let current, var settings = draft.carSettings else { return }
                settings.targetStateOfCharge = max(settings.targetStateOfCharge, current)
                draft.carSettings = settings
            }
            .confirmationDialog("Discard changes to this job?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
                Button("Discard Changes", role: .destructive, action: onCancel)
                Button("Keep Editing", role: .cancel) {}
            }
        }
        .interactiveDismissDisabled(hasUnsavedChanges)
        .background(SheetDismissAttemptObserver(onAttempt: requestDismiss))
    }

    func decimalStepper(_ title: String, value: Binding<Double>, range: ClosedRange<Double>, step: Double, unit: String) -> some View {
        Stepper(value: value, in: range, step: step) {
            ViewThatFits(in: .horizontal) {
                HStack {
                    Text(title)
                    Spacer(minLength: 8)
                    Text("\(value.wrappedValue.formatted(.number.precision(.fractionLength(0 ... 1)))) \(unit)")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                    Text("\(value.wrappedValue.formatted(.number.precision(.fractionLength(0 ... 1)))) \(unit)")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityLabel(title)
        .accessibilityValue("\(value.wrappedValue.formatted(.number.precision(.fractionLength(0 ... 1)))) \(unit)")
        .accessibilityHint("Use the stepper to change the value")
    }

    func carValue(_ keyPath: WritableKeyPath<CarLoadSettings, Double>) -> Binding<Double> {
        Binding(
            get: { draft.carSettings?[keyPath: keyPath] ?? 0 },
            set: { newValue in
                guard var settings = draft.carSettings else { return }
                settings[keyPath: keyPath] = newValue
                draft.carSettings = settings
            }
        )
    }

    var carLevelBinding: Binding<CarChargingLevel> {
        Binding(
            get: { draft.carSettings?.chargingLevel ?? .level2 },
            set: { newValue in
                guard var settings = draft.carSettings else { return }
                settings.chargingLevel = newValue
                draft.carSettings = settings
            }
        )
    }

    var carEstimateSummary: String {
        guard let settings = draft.carSettings else { return "Enter car settings to calculate the estimate." }
        guard let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings) else { return "Check the car settings to calculate the estimate." }
        guard estimate.batteryKwh > 0 else { return "No energy will be added at this charge target." }
        return "About \(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kWh to add, with charging losses excluded from that amount. Estimated charging time is \(estimate.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))) hours at Level \(settings.chargingLevel == .level1 ? "1" : "2")."
    }
}

#Preview("Load profiles · built-ins and custom") {
    let defaults = UserDefaults(suiteName: "LoadProfilesSheetPreview")!
    defaults.removePersistentDomain(forName: "LoadProfilesSheetPreview")
    let store = LoadProfileStore(userDefaults: defaults)
    _ = try? store.createCustomProfile(name: "Workshop heater", energyKwh: 6, durationHours: 2)
    _ = try? store.createCustomProfile(name: "Garden pump", energyKwh: 1.5, durationHours: 0.5)
    return LoadProfilesSheet(store: store)
}

#Preview("Load profiles · accessibility size") {
    let defaults = UserDefaults(suiteName: "LoadProfilesSheetAccessibilityPreview")!
    defaults.removePersistentDomain(forName: "LoadProfilesSheetAccessibilityPreview")
    let store = LoadProfileStore(userDefaults: defaults)
    _ = try? store.createCustomProfile(name: "Workshop heater", energyKwh: 6, durationHours: 2)
    _ = try? store.createCustomProfile(name: "Garden pump", energyKwh: 1.5, durationHours: 0.5)
    return LoadProfilesSheet(store: store)
        .environment(\.dynamicTypeSize, .accessibility3)
}
