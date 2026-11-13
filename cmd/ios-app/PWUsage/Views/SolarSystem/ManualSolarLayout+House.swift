import Foundation

extension ManualSolarLayout {
    /// The house's panel groups from the faces the owner entered, one per face of every system
    /// installed by `date`, with the entered panel count. A face with no direction or tilt takes
    /// the largest detected plane's, or south and a modest pitch when nothing was detected.
    func houseGroups(detected: SolarLayout?, on date: Date) -> [SolarSystemHouse.Group] {
        let fallback = detected?.planes.max { $0.dcKwp < $1.dcKwp }
        return installedSystems(on: date).flatMap(\.faces).map { face in
            SolarSystemHouse.Group(
                azimuth: face.azimuthDegrees ?? fallback?.azimuth ?? 180,
                tilt: face.tiltDegrees ?? fallback?.tilt ?? 22,
                kilowatts: face.nameplateKw,
                panelCount: face.panelCount)
        }
    }
}
