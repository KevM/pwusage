import Foundation
import PWUsageCore

/// A three-system manual layout shared by the core record tests and the app's CloudKit and store tests
/// (`project.yml` compiles this file into `PWUsageTests` too).
enum ManualSolarLayoutFixtures {
    static func layout(label: String = "Original 2016 install") -> ManualSolarLayout {
        ManualSolarLayout(systems: [
            ManualSolarSystem(
                label: label, installDate: Date(timeIntervalSince1970: 1_450_000_000), inverterAcKw: 7.6,
                faces: [
                    face("South roof", 14, 285, azimuth: 180, tilt: 22),
                    face("West roof", 6, 285, azimuth: 270, tilt: 22),
                    face("Porch", 2, 285, azimuth: nil, tilt: nil)
                ]),
            ManualSolarSystem(
                label: "2023 addition", installDate: Date(timeIntervalSince1970: 1_680_000_000), inverterAcKw: nil,
                faces: [
                    face("South roof", 8, 410, azimuth: 180, tilt: 22),
                    face(nil, 4, 410, azimuth: 90, tilt: 22)
                ]),
            ManualSolarSystem(
                label: nil, installDate: nil, inverterAcKw: nil,
                faces: [
                    face("Garage east", 5, 400, azimuth: 90, tilt: 15),
                    face("Garage west", 5, 400, azimuth: 270, tilt: 15),
                    face("Shed", 1, 400, azimuth: 180, tilt: 10)
                ])
        ])
    }

    private static func face(
        _ label: String?, _ panels: Int, _ watts: Double, azimuth: Double?, tilt: Double?
    ) -> ManualSolarFace {
        ManualSolarFace(label: label, panelCount: panels, panelWatts: watts, azimuthDegrees: azimuth, tiltDegrees: tilt)
    }
}
