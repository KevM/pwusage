import Foundation

extension ManualSolarLayout {
    /// What the editor opens with when nothing was entered yet: one system, one face, with the
    /// largest detected plane's direction and tilt filled in.
    static func starting(detected: DetectedSolarLayout?) -> ManualSolarLayout {
        var system = ManualSolarSystem(label: nil, installDate: nil, inverterAcKw: nil, faces: [])
        system.addFace(detected: detected)
        return ManualSolarLayout(systems: [system])
    }

    /// Install dates to the start of their month, and blank labels to nil, as saved.
    func normalized(calendar: Calendar = .current) -> ManualSolarLayout {
        ManualSolarLayout(systems: systems.map { system in
            var copy = system
            copy.label = Self.trimmed(system.label)
            copy.installDate = system.installDate.flatMap {
                calendar.date(from: calendar.dateComponents([.year, .month], from: $0))
            }
            copy.faces = system.faces.map { face in
                var faceCopy = face
                faceCopy.label = Self.trimmed(face.label)
                return faceCopy
            }
            return copy
        })
    }

    private static func trimmed(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }
}

extension ManualSolarSystem {
    /// Panel wattage is per face but a system's panels usually match, so a new face copies the last
    /// one's. Direction and tilt come from the detected planes, largest first, one per face.
    mutating func addFace(detected: DetectedSolarLayout?) {
        let planes = (detected?.planes ?? []).sorted { $0.dcKwp > $1.dcKwp }
        let plane = planes.indices.contains(faces.count) ? planes[faces.count] : nil
        faces.append(ManualSolarFace(
            label: nil, panelCount: 10, panelWatts: faces.last?.panelWatts ?? 400,
            azimuthDegrees: plane?.azimuth, tiltDegrees: plane?.tilt))
    }
}
