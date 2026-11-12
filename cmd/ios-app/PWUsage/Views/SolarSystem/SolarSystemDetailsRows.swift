import SwiftUI

/// The found system, as rows under its render: total size, then each panel group's size, direction,
/// tilt and confidence. While loading continues it says "Improving" in one word. Panels the owner
/// entered replace the found groups.
struct SolarSystemDetailsRows: View {
    let layout: SolarLayout
    var manual: ManualSolarLayout?
    var isImproving = false

    private var groups: [SolarLayoutPlane] { layout.planes.sorted { $0.dcKwp > $1.dcKwp } }

    var body: some View {
        if let manual {
            // Detection confidence says nothing about values the owner entered, so it is not shown.
            ManualLayoutRows(layout: manual, detected: layout)
        } else {
            detectedRows
            confidenceRow
        }
    }

    @ViewBuilder private var detectedRows: some View {
        LabeledContent("Total size") {
            Text(Self.kilowatts(layout.planes.reduce(0) { $0 + $1.dcKwp }))
        }
        ForEach(Array(groups.enumerated()), id: \.offset) { index, plane in
            VStack(alignment: .leading, spacing: 4) {
                Text(groups.count == 1 ? "Panels" : "Group \(index + 1)").font(.subheadline.weight(.semibold))
                LabeledContent("Size", value: Self.kilowatts(plane.dcKwp))
                LabeledContent("Direction", value: Self.direction(plane.azimuth))
                LabeledContent("Tilt", value: "\(Int(plane.tilt.rounded()))°")
            }
            .accessibilityElement(children: .combine)
        }
    }

    private var confidenceRow: some View {
        LabeledContent("Confidence") {
            HStack(spacing: 6) {
                Text(layout.confidence == .high ? "High" : "Medium")
                if isImproving {
                    Text("Improving")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(SolarSystemColors.clear.opacity(0.2), in: Capsule())
                }
            }
        }
    }

    static func kilowatts(_ value: Double) -> String {
        "\(value.formatted(.number.precision(.fractionLength(1)))) kW"
    }

    /// "SSW 202°".
    static func direction(_ azimuth: Double) -> String {
        let degrees = Int(azimuth.rounded()) % 360
        return "\(SolarSystemCompass.abbreviation(azimuth)) \(degrees)°"
    }
}

/// The owner's systems and faces, in place of the found groups. The Settings row says Configured.
private struct ManualLayoutRows: View {
    let layout: ManualSolarLayout
    let detected: SolarLayout

    var body: some View {
        LabeledContent("Total size", value: SolarSystemDetailsRows.kilowatts(layout.nameplateKw(on: .now)))
        ForEach(Array(layout.systems.enumerated()), id: \.element.id) { index, system in
            VStack(alignment: .leading, spacing: 4) {
                Text(system.label ?? "System \(index + 1)").font(.subheadline.weight(.semibold))
                if let installed = system.installDate {
                    LabeledContent("Installed", value: installed.formatted(.dateTime.month(.wide).year()))
                }
                ForEach(system.faces) { face in faceRow(face) }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func faceRow(_ face: ManualSolarFace) -> some View {
        let fallback = detected.planes.max { $0.dcKwp < $1.dcKwp }
        let azimuth = face.azimuthDegrees ?? fallback?.azimuth
        let tilt = face.tiltDegrees ?? fallback?.tilt
        let size = "\(face.panelCount) × \(Int(face.panelWatts.rounded())) W"
        let facing = [
            azimuth.map(SolarSystemDetailsRows.direction),
            tilt.map { "\(Int($0.rounded()))° tilt" }
        ].compactMap(\.self).joined(separator: ", ")
        return LabeledContent(face.label ?? "Face", value: facing.isEmpty ? size : "\(size), \(facing)")
    }
}
