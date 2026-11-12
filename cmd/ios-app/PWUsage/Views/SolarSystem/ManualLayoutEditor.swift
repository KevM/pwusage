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
    @FocusState private var focus: ManualLayoutField?

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
                        canRemove: draft.systems.count > 1, focus: $focus) { remove(system) }
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
                // The decimal pad has no Return key.
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focus = nil }
                }
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

/// One system: its label, install month and faces. The inverter rating is not asked for: the
/// detector measures clipping from production, which beats a typed number (and microinverters have
/// no single system-wide limit).
private struct ManualSystemSection: View {
    @Binding var system: ManualSolarSystem
    let number: Int
    let detected: DetectedSolarLayout?
    let canRemove: Bool
    let focus: FocusState<ManualLayoutField?>.Binding
    let onRemove: () -> Void

    var body: some View {
        Section {
            TextField("Name (optional)", text: $system.label.textFieldValue)
            Toggle("Installed date", isOn: hasInstallDate)
            if system.installDate != nil {
                DatePicker(
                    "Installed", selection: installDate, in: ...Date.now, displayedComponents: .date)
            }
            ForEach($system.faces) { $face in
                ManualFaceFields(face: $face, detected: detected, focus: focus,
                                 onRemove: system.faces.count > 1 ? { removeFace(face) } : nil)
            }
            Button("Add Face") { system.addFace(detected: detected) }
            if canRemove { Button("Remove System", role: .destructive, action: onRemove) }
        } header: {
            Text(system.label ?? "System \(number)")
        } footer: {
            Text("A face is one roof plane.")
        }
    }

    private func removeFace(_ face: ManualSolarFace) {
        system.faces.removeAll { $0.id == face.id }
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
    let focus: FocusState<ManualLayoutField?>.Binding
    /// Nil for the system's only face, which cannot be removed.
    let onRemove: (() -> Void)?

    /// Each field is its own list row: several fields in one row compete for the tap and the caret
    /// lands in the wrong one, or nowhere.
    var body: some View {
        TextField("Face name (optional)", text: $face.label.textFieldValue)
            .font(.subheadline.weight(.semibold))
        numberRow("Panels", field: .panels(face.id)) {
            TextField("Count", value: $face.panelCount, format: .number)
        }
        numberRow("Panel watts", field: .watts(face.id)) {
            TextField("Watts", value: $face.panelWatts, format: .number)
        }
        numberRow("Direction (°)", field: .azimuth(face.id)) {
            TextField(hint(\.azimuth), value: $face.azimuthDegrees, format: .number)
        }
        numberRow("Tilt (°)", field: .tilt(face.id)) {
            TextField(hint(\.tilt), value: $face.tiltDegrees, format: .number)
        }
        if let onRemove {
            Button("Remove Face", role: .destructive, action: onRemove)
        }
    }

    private func numberRow(
        _ title: String, field: ManualLayoutField, @ViewBuilder content: () -> some View
    ) -> some View {
        ManualNumberRow(title: title, field: field, focus: focus, content: content)
    }

    /// The detected value for a face, shown where the field is empty.
    private func hint(_ value: KeyPath<DetectedSolarLayout.Plane, Double>) -> String {
        guard let plane = detected?.planes.max(by: { $0.dcKwp < $1.dcKwp }) else { return "Optional" }
        return "Found: \(Int(plane[keyPath: value].rounded()))"
    }
}

/// Which number field has the keyboard.
enum ManualLayoutField: Hashable {
    case panels(UUID), watts(UUID), azimuth(UUID), tilt(UUID)
}

/// A title and a right-aligned number field. The whole row focuses the field, so a tap on the title
/// or the empty space places the caret, not only a tap on the text itself.
private struct ManualNumberRow<Content: View>: View {
    let title: String
    let field: ManualLayoutField
    let focus: FocusState<ManualLayoutField?>.Binding
    @ViewBuilder let content: Content

    var body: some View {
        HStack {
            Text(title)
            content
                .multilineTextAlignment(.trailing)
                .decimalKeyboard()
                .focused(focus, equals: field)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .onTapGesture { focus.wrappedValue = field }
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
