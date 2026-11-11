import SwiftUI

/// Entered and detected values side by side before saving. Differences are information only:
/// Save is always available, since the owner knows their roof better than the fit does.
struct ManualLayoutReview: View {
    let layout: ManualSolarLayout
    let detected: DetectedSolarLayout?
    let isSaving: Bool
    let onSave: () async -> Void

    private var flags: [ManualLayoutFlag] {
        ManualLayoutComparison.flags(manual: layout, detected: detected, on: .now)
    }

    var body: some View {
        List {
            Section("You entered") {
                LabeledContent("Total size", value: SolarSystemDetailsRows.kilowatts(layout.nameplateKw(on: .now)))
                ForEach(layout.systems) { system in
                    ForEach(system.faces) { face in entered(face) }
                }
            }
            if let detected, detected.status == .detected {
                Section("Found from your production") {
                    LabeledContent("Production implies", value: SolarSystemDetailsRows.kilowatts(
                        detected.planes.reduce(0) { $0 + $1.effectiveKw }))
                    ForEach(Array(detected.planes.enumerated()), id: \.offset) { _, plane in
                        LabeledContent(
                            SolarSystemDetailsRows.direction(plane.azimuth),
                            value: "\(Int(plane.tilt.rounded()))° tilt")
                    }
                }
            }
            differencesSection
            Section {
                Button("Save Panels") { Task { await onSave() } }
                    .emphasisProminentButton()
                    .disabled(isSaving)
            }
        }
        .navigationTitle("Review")
        .inlineNavigationTitle()
    }

    private func entered(_ face: ManualSolarFace) -> some View {
        let direction = face.azimuthDegrees.map(SolarSystemDetailsRows.direction) ?? "Direction found"
        return LabeledContent(
            "\(face.panelCount) × \(Int(face.panelWatts.rounded())) W", value: direction)
    }

    @ViewBuilder private var differencesSection: some View {
        Section {
            if flags.isEmpty {
                Text("What you entered matches what was found.")
            } else {
                ForEach(Array(flags.enumerated()), id: \.offset) { _, flag in Text(Self.message(for: flag)) }
            }
        } header: {
            Text("Differences")
        } footer: {
            if !flags.isEmpty { Text("You can still save. These only point at what might be worth a second look.") }
        }
    }

    static func message(for flag: ManualLayoutFlag) -> String {
        switch flag {
        case .azimuthOutsideDetectedRange(_, let entered, let found):
            "A face points \(Int(entered.rounded()))°, more than 5° from the \(Int(found.rounded()))° found."
        case .tiltOutsideDetectedRange(_, let entered, let found):
            "A face is tilted \(Int(entered.rounded()))°, more than 5° from the \(Int(found.rounded()))° found."
        case .directionCountDiffers(let entered, let found):
            "You entered \(count(entered, "direction")); \(found) \(found == 1 ? "was" : "were") found."
        case .capacityOutsideBand(let fitted, let nameplate):
            "Your production implies about \(SolarSystemDetailsRows.kilowatts(fitted)) from panels rated "
                + "\(SolarSystemDetailsRows.kilowatts(nameplate)). A healthy system usually makes 60–90%."
        }
    }

    private static func count(_ number: Int, _ noun: String) -> String {
        "\(number) \(noun)\(number == 1 ? "" : "s")"
    }
}
