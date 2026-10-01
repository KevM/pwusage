import SwiftUI

struct LoadProfilesSheet: View {
    @ObservedObject var store: LoadProfileStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var draft: ProfileDraft?
    @State private var pendingDeletion: LoadProfile?
    @State private var pendingReset: LoadProfile?
    @State private var validationMessage: String?

    var body: some View {
        NavigationStack {
            List {
                Section("Load Profiles") {
                    ForEach(store.profiles) { profile in
                        profileRow(profile)
                    }
                    .onMove { offsets, destination in
                        store.moveProfiles(fromOffsets: offsets, toOffset: destination)
                    }
                    Button {
                        draft = ProfileDraft.newCustom()
                    } label: {
                        Label("Add custom load", systemImage: "plus.circle.fill")
                    }
                    .accessibilityHint("Creates a named load profile with energy and duration settings")
                }

                Section {
                    Text("Choosing or reordering profiles applies immediately. Profile edits take effect when you save.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .navigationTitle("Load Profiles")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    EditButton()
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(item: $draft) { value in
                ProfileEditorSheet(
                    draft: value,
                    onCancel: { draft = nil },
                    onSave: save
                )
            }
            .confirmationDialog(
                "Delete \(pendingDeletion?.name ?? "custom load")?",
                isPresented: Binding(
                    get: { pendingDeletion != nil },
                    set: { if !$0 { pendingDeletion = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete Custom Load", role: .destructive) {
                    guard let profile = pendingDeletion else { return }
                    do {
                        try store.deleteCustomProfile(id: profile.id)
                        pendingDeletion = nil
                    } catch {
                        validationMessage = message(for: error)
                    }
                }
                Button("Cancel", role: .cancel) { pendingDeletion = nil }
            } message: {
                Text("This removes the profile from this device.")
            }
            .confirmationDialog(
                "Reset \(pendingReset?.name ?? "profile") to its default settings?",
                isPresented: Binding(
                    get: { pendingReset != nil },
                    set: { if !$0 { pendingReset = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Reset to Defaults", role: .destructive) {
                    guard let profile = pendingReset else { return }
                    do {
                        try store.resetBuiltInProfile(id: profile.id)
                        pendingReset = nil
                    } catch {
                        validationMessage = message(for: error)
                    }
                }
                Button("Cancel", role: .cancel) { pendingReset = nil }
            }
            .alert("Couldn’t update load profiles", isPresented: Binding(
                get: { validationMessage != nil },
                set: { if !$0 { validationMessage = nil } }
            )) {
                Button("OK", role: .cancel) { validationMessage = nil }
            } message: {
                Text(validationMessage ?? "Check the profile values and try again.")
            }
        }
    }

    @ViewBuilder
    private func profileRow(_ profile: LoadProfile) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Button {
                do {
                    try store.selectProfile(id: profile.id)
                } catch {
                    validationMessage = message(for: error)
                }
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: store.selectedProfileID == profile.id ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(store.selectedProfileID == profile.id ? .indigo : .secondary)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(profile.name)
                            .font(.body.weight(.medium))
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                        Text(profileSummary(profile))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(profileAccessibilitySummary(profile))
            .accessibilityAddTraits(store.selectedProfileID == profile.id ? .isSelected : [])

            Menu {
                Button("Edit") { draft = ProfileDraft(profile: profile) }
                if profile.kind == .custom {
                    Button("Delete", role: .destructive) { pendingDeletion = profile }
                } else {
                    Button("Reset to Defaults", role: .destructive) { pendingReset = profile }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Actions for \(profile.name)")
        }
        .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 5 : 1)
    }

    private func save(_ draft: ProfileDraft) {
        guard draft.isValid else {
            validationMessage = draft.kind == .custom && draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "Enter a name for this custom load."
                : "Energy and duration must be greater than zero. Check the car charge settings too."
            return
        }
        do {
            let saved: LoadProfile
            if let id = draft.id {
                saved = try store.editProfile(
                    id: id,
                    name: draft.kind == .custom ? draft.name : nil,
                    energyKwh: draft.energyKwh,
                    durationHours: draft.durationHours,
                    carSettings: draft.carSettings
                )
            } else {
                saved = try store.createCustomProfile(name: draft.name, energyKwh: draft.energyKwh, durationHours: draft.durationHours)
            }
            try store.selectProfile(id: saved.id)
            self.draft = nil
        } catch {
            validationMessage = message(for: error)
        }
    }

    /// Surfaces the store's own reason for the failure, so a new `LoadProfileError`
    /// case explains itself instead of falling back to a generic string.
    private func message(for error: Error) -> String {
        if let loadProfileError = error as? LoadProfileError,
           let description = loadProfileError.errorDescription {
            return description
        }
        return "Check the profile values and try again."
    }

    private func profileSummary(_ profile: LoadProfile) -> String {
        guard profile.kind == .car, let car = profile.carSettings else {
            return "\(profile.energyKwh.formatted(.number.precision(.fractionLength(0...1)))) kWh · \(profile.durationHours.formatted(.number.precision(.fractionLength(0...1)))) hr"
        }
        guard let estimate = LoadTimingEstimator.carChargeEstimate(settings: car) else { return "Car estimate unavailable" }
        return "\(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0...1)))) kWh to add · about \(estimate.durationHours.formatted(.number.precision(.fractionLength(0...1)))) hr"
    }

    private func profileAccessibilitySummary(_ profile: LoadProfile) -> String {
        if profile.kind == .car, let car = profile.carSettings,
           let estimate = LoadTimingEstimator.carChargeEstimate(settings: car) {
            return "\(profile.name), \(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0...1)))) kilowatt-hours to add, about \(estimate.durationHours.formatted(.number.precision(.fractionLength(0...1)))) hours at Level \(car.chargingLevel == .level1 ? "1" : "2")"
        }
        return "\(profile.name), \(profile.energyKwh.formatted(.number.precision(.fractionLength(0...1)))) kilowatt-hours, \(profile.durationHours.formatted(.number.precision(.fractionLength(0...1)))) hours"
    }
}

private struct ProfileDraft: Identifiable {
    var id: String?
    var name: String
    var kind: LoadProfileKind
    var energyKwh: Double
    var durationHours: Double
    var carSettings: CarLoadSettings?

    var sheetID: String { id ?? "new-custom" }
    var isValid: Bool {
        energyKwh.isFinite && energyKwh > 0 && durationHours.isFinite && durationHours > 0 &&
        (kind != .custom || !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) &&
        (kind != .car || carSettings.map {
            $0.capacityKwh.isFinite && $0.capacityKwh > 0 && $0.capacityKwh <= LoadProfile.maximumCarCapacityKwh &&
            (0...100).contains($0.initialStateOfCharge) &&
            ($0.initialStateOfCharge...100).contains($0.targetStateOfCharge)
        } == true)
    }

    init(profile: LoadProfile) {
        id = profile.id
        name = profile.name
        kind = profile.kind
        energyKwh = profile.energyKwh
        durationHours = profile.durationHours
        carSettings = profile.carSettings
    }

    private init() {
        id = nil
        name = "Custom load"
        kind = .custom
        energyKwh = 20
        durationHours = 4
        carSettings = nil
    }

    static func newCustom() -> ProfileDraft { ProfileDraft() }
}

private struct ProfileEditorSheet: View {
    @State var draft: ProfileDraft
    let onCancel: () -> Void
    let onSave: (ProfileDraft) -> Void
    @FocusState private var nameFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                if draft.kind == .custom {
                    Section("Name") {
                        TextField("Load name", text: $draft.name)
                            .textContentType(.name)
                            .focused($nameFocused)
                            .accessibilityLabel("Custom load name")
                    }
                } else {
                    Section("Profile") {
                        LabeledContent("Load", value: draft.name)
                    }
                }

                if draft.kind == .car, let settings = draft.carSettings {
                    Section("Car") {
                        decimalStepper("Battery capacity", value: carValue(\.capacityKwh), range: 1...LoadProfile.maximumCarCapacityKwh, step: 1, unit: "kWh")
                        decimalStepper("Current charge", value: carValue(\.initialStateOfCharge), range: 0...100, step: 1, unit: "%")
                        decimalStepper("Target charge", value: carValue(\.targetStateOfCharge), range: settings.initialStateOfCharge...100, step: 1, unit: "%")
                        Picker("Charging level", selection: carLevelBinding) {
                            Text("Level 1").tag(CarChargingLevel.level1)
                            Text("Level 2").tag(CarChargingLevel.level2)
                        }
                        .accessibilityLabel("Charging level")
                    }
                }

                if draft.kind != .car {
                    Section("Load estimate") {
                        decimalStepper("Energy", value: $draft.energyKwh, range: 0.1...500, step: 0.5, unit: "kWh")
                        decimalStepper("Duration", value: $draft.durationHours, range: 0.1...48, step: 0.5, unit: "hours")
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
            .navigationTitle(draft.id == nil ? "New Custom Load" : "Edit Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
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
        }
    }

    private func decimalStepper(_ title: String, value: Binding<Double>, range: ClosedRange<Double>, step: Double, unit: String) -> some View {
        Stepper(value: value, in: range, step: step) {
            ViewThatFits(in: .horizontal) {
                HStack {
                    Text(title)
                    Spacer(minLength: 8)
                    Text("\(value.wrappedValue.formatted(.number.precision(.fractionLength(0...1)))) \(unit)")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                    Text("\(value.wrappedValue.formatted(.number.precision(.fractionLength(0...1)))) \(unit)")
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityLabel(title)
        .accessibilityValue("\(value.wrappedValue.formatted(.number.precision(.fractionLength(0...1)))) \(unit)")
        .accessibilityHint("Use the stepper to change the value")
    }

    private func carValue(_ keyPath: WritableKeyPath<CarLoadSettings, Double>) -> Binding<Double> {
        Binding(
            get: { draft.carSettings?[keyPath: keyPath] ?? 0 },
            set: { newValue in
                guard var settings = draft.carSettings else { return }
                settings[keyPath: keyPath] = newValue
                draft.carSettings = settings
            }
        )
    }

    private var carLevelBinding: Binding<CarChargingLevel> {
        Binding(
            get: { draft.carSettings?.chargingLevel ?? .level2 },
            set: { newValue in
                guard var settings = draft.carSettings else { return }
                settings.chargingLevel = newValue
                draft.carSettings = settings
            }
        )
    }

    private var carEstimateSummary: String {
        guard let settings = draft.carSettings else { return "Enter car settings to calculate the estimate." }
        guard let estimate = LoadTimingEstimator.carChargeEstimate(settings: settings) else { return "Check the car settings to calculate the estimate." }
        guard estimate.batteryKwh > 0 else { return "No energy will be added at this charge target." }
        return "About \(estimate.batteryKwh.formatted(.number.precision(.fractionLength(0...1)))) kWh to add, with charging losses excluded from that amount. Estimated charging time is \(estimate.durationHours.formatted(.number.precision(.fractionLength(0...1)))) hours at Level \(settings.chargingLevel == .level1 ? "1" : "2")."
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
