import SwiftUI

/// The found system: total size, then each panel group's size, direction, tilt and confidence.
/// While loading continues it says "Improving" in one word.
struct SolarSystemDetailsCard: View {
    let layout: SolarLayout
    var isImproving = false

    private var groups: [SolarLayoutPlane] { layout.planes.sorted { $0.dcKwp > $1.dcKwp } }

    var body: some View {
        Section {
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
        } header: {
            Text("System")
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
