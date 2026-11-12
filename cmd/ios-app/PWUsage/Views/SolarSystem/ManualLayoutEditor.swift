import SwiftUI

/// Enter the solar system as it was installed: systems, each with its panel faces. Route-agnostic:
/// it edits a draft and hands the result to `onSave`, so a future historical entry can reuse it.
/// With a detected layout, "Review" shows the entered and detected values side by side before saving.
struct ManualLayoutEditor: View {
    let detected: DetectedSolarLayout?
    /// Whether a layout was entered before, which a Remove button then clears.
    let hasEntered: Bool
    /// Stores the layout, or clears it with nil. Returns whether it was stored.
    let onSave: (ManualSolarLayout?) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var draft: ManualSolarLayout
    @State private var isSaving = false
    @State private var didFailToSave = false
    @State private var isReviewing = false

    init(
        initial: ManualSolarLayout?, detected: DetectedSolarLayout?,
        onSave: @escaping (ManualSolarLayout?) async -> Bool
    ) {
        self.detected = detected
        hasEntered = initial != nil
        self.onSave = onSave
        _draft = State(initialValue: initial ?? .starting(detected: detected))
    }

    var body: some View {
        NavigationStack {
            Form {
                ForEach($draft.systems) { $system in
                    ManualSystemSection(
                        system: $system, number: number(of: system), detected: detected,
                        canRemove: draft.systems.count > 1) { remove(system) }
                }
                Section {
                    Button("Add Another System") { draft.systems.append(newSystem()) }
                } footer: {
                    Text("A separate install, such as panels added later, with its own age and panels.")
                }
                if hasEntered { removeSection }
                if didFailToSave {
                    Section { Text("Couldn’t save your panels. Try again.").foregroundStyle(.red) }
                }
            }
            .navigationTitle("Edit Solar System")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { primaryButton }
            }
            .navigationDestination(isPresented: $isReviewing) {
                ManualLayoutReview(layout: draft, detected: detected, isSaving: isSaving) { await save(draft) }
            }
            .disabled(isSaving)
        }
    }

    @ViewBuilder private var primaryButton: some View {
        if detected?.status == .detected {
            Button("Review") { isReviewing = true }.disabled(!draft.isValid)
        } else {
            Button("Save") { Task { await save(draft) } }.disabled(!draft.isValid)
        }
    }

    private var removeSection: some View {
        Section {
            Button("Remove Entered Panels", role: .destructive) { Task { await save(nil) } }
        } footer: {
            Text("Goes back to the panels found from your production.")
        }
    }

    private func number(of system: ManualSolarSystem) -> Int {
        (draft.systems.firstIndex { $0.id == system.id } ?? 0) + 1
    }

    private func remove(_ system: ManualSolarSystem) {
        draft.systems.removeAll { $0.id == system.id }
    }

    private func newSystem() -> ManualSolarSystem {
        var system = ManualSolarSystem(label: nil, installDate: nil, inverterAcKw: nil, faces: [])
        system.addFace(detected: nil)
        return system
    }

    private func save(_ layout: ManualSolarLayout?) async {
        isSaving = true
        defer { isSaving = false }
        if await onSave(layout) {
            dismiss()
        } else {
            didFailToSave = true
            isReviewing = false
        }
    }
}

/// One system: its label, install month, inverter rating and faces.
private struct ManualSystemSection: View {
    @Binding var system: ManualSolarSystem
    let number: Int
    let detected: DetectedSolarLayout?
    let canRemove: Bool
    let onRemove: () -> Void

    var body: some View {
        Section {
            TextField("Name (optional)", text: $system.label.textFieldValue)
            Toggle("Installed date", isOn: hasInstallDate)
            if system.installDate != nil {
                DatePicker(
                    "Installed", selection: installDate, in: ...Date.now, displayedComponents: .date)
            }
            LabeledContent("Inverter (kW)") {
                TextField("Optional", value: $system.inverterAcKw, format: .number)
                    .multilineTextAlignment(.trailing)
                    .decimalKeyboard()
            }
            ForEach($system.faces) { $face in
                ManualFaceFields(face: $face, detected: detected)
            }
            .onDelete { system.faces.remove(atOffsets: $0) }
            Button("Add Face") { system.addFace(detected: detected) }
            if canRemove { Button("Remove System", role: .destructive, action: onRemove) }
        } header: {
            Text(system.label ?? "System \(number)")
        } footer: {
            Text("A face is one roof plane. Swipe a face to delete it.")
        }
    }

    private var hasInstallDate: Binding<Bool> {
        Binding(
            get: { system.installDate != nil },
            set: { system.installDate = $0 ? (system.installDate ?? .now) : nil })
    }

    private var installDate: Binding<Date> {
        Binding(get: { system.installDate ?? .now }, set: { system.installDate = $0 })
    }
}

/// One face: panels, wattage, direction and tilt. Direction and tilt show the detected value as a
/// hint and fall back to it when left empty.
private struct ManualFaceFields: View {
    @Binding var face: ManualSolarFace
    let detected: DetectedSolarLayout?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField("Face name (optional)", text: $face.label.textFieldValue).font(.subheadline.weight(.semibold))
            numberRow("Panels") { TextField("Count", value: $face.panelCount, format: .number) }
            numberRow("Panel watts") { TextField("Watts", value: $face.panelWatts, format: .number) }
            numberRow("Direction (°)") {
                TextField(hint(\.azimuth), value: $face.azimuthDegrees, format: .number)
            }
            numberRow("Tilt (°)") {
                TextField(hint(\.tilt), value: $face.tiltDegrees, format: .number)
            }
        }
        .padding(.vertical, 2)
    }

    private func numberRow(_ title: String, @ViewBuilder field: () -> some View) -> some View {
        LabeledContent(title) {
            field().multilineTextAlignment(.trailing).decimalKeyboard()
        }
    }

    /// The detected value for a face, shown where the field is empty.
    private func hint(_ value: KeyPath<DetectedSolarLayout.Plane, Double>) -> String {
        guard let plane = detected?.planes.max(by: { $0.dcKwp < $1.dcKwp }) else { return "Optional" }
        return "Found: \(Int(plane[keyPath: value].rounded()))"
    }
}

extension Optional where Wrapped == String {
    /// A text field's binding for an optional string.
    var textFieldValue: String {
        get { self ?? "" }
        set { self = newValue.isEmpty ? nil : newValue }
    }
}

extension View {
    @ViewBuilder func decimalKeyboard() -> some View {
        #if os(iOS)
            keyboardType(.decimalPad)
        #else
            self
        #endif
    }
}
