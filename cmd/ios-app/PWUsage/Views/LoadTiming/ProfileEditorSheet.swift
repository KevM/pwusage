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
                Section("Name") {
                    TextField(draft.kind == .car ? "Model Y" : "Bake bread", text: $draft.name)
                        .textContentType(.name)
                        .focused($nameFocused)
                        .accessibilityLabel("Job name")
                }

                if draft.kind == .car, let settings = draft.carSettings {
                    Section("Car") {
                        decimalStepper(
                            "Battery capacity", value: carValue(\.capacityKwh),
                            range: 1 ... LoadProfile.maximumCarCapacityKwh, step: 1, unit: "kWh")
                        decimalStepper(
                            "Current charge", value: currentChargeBinding, range: 0 ... 100,
                            step: CarChargeSteps.step, unit: "%")
                        decimalStepper(
                            "Target charge", value: targetChargeBinding,
                            range: settings.initialStateOfCharge ... 100, step: CarChargeSteps.step, unit: "%")
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
                        decimalStepper(
                            "Duration", value: $draft.durationHours, range: 0.1 ... 48, step: 0.5,
                            unit: "hours")
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
            .navigationTitle(newJobTitle)
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
            .confirmationDialog(
                "Discard changes to this job?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
                    Button("Discard Changes", role: .destructive, action: onCancel)
                    Button("Keep Editing", role: .cancel) {}
            }
        }
        .interactiveDismissDisabled(hasUnsavedChanges)
        .background(SheetDismissAttemptObserver(onAttempt: requestDismiss))
    }

    func decimalStepper(
        _ title: String, value: Binding<Double>, range: ClosedRange<Double>, step: Double,
        unit: String) -> some View {
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

    var newJobTitle: String {
        guard draft.id == nil else { return "Edit Job" }
        return draft.kind == .car ? "New Car" : "New Custom Job"
    }

    /// Steppers add 5 to the exact saved value; the setter snaps the result to the 5% grid and keeps the
    /// target at or above the current charge.
    var currentChargeBinding: Binding<Double> {
        Binding(
            get: { draft.carSettings?.initialStateOfCharge ?? 0 },
            set: { newValue in
                guard let settings = draft.carSettings else { return }
                draft.carSettings = CarChargeSteps.settings(settings, settingCurrent: newValue)
            }
        )
    }

    var targetChargeBinding: Binding<Double> {
        Binding(
            get: { draft.carSettings?.targetStateOfCharge ?? 0 },
            set: { newValue in
                guard let settings = draft.carSettings else { return }
                draft.carSettings = CarChargeSteps.settings(settings, settingTarget: newValue)
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
        guard let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings) else {
            return "Check the car settings to calculate the estimate."
        }
        guard estimate.batteryKwh > 0 else { return "No energy will be added at this charge target." }
        return "About \(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0 ... 1)))) kWh to add, "
            + "with charging losses excluded from that amount. Estimated charging time is "
            + "\(estimate.durationHours.formatted(.number.precision(.fractionLength(0 ... 1)))) hours at Level "
            + "\(settings.chargingLevel == .level1 ? "1" : "2")."
    }
}
