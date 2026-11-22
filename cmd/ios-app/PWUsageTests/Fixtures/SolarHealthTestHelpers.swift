import Foundation
import PWUsageCore

extension SolarHealthPlane {
    /// A face of `powerKw` effective size.
    static func face(_ azimuth: Double, tilt: Double = 25, kw powerKw: Double = 3) -> SolarHealthPlane {
        SolarHealthPlane(azimuth: azimuth, tilt: tilt, effectiveKw: powerKw)
    }
}

/// A manual layout whose faces are `planes` at nameplate, so the health reference models them
/// at the detector's derate.
func manualLayout(for planes: [SolarHealthPlane], installDates: [Date?]? = nil) -> ManualSolarLayout {
    let systems = planes.enumerated().map { index, plane in
        ManualSolarSystem(
            installDate: installDates?[index], faces: [ManualSolarFace(
                panelCount: 10, panelWatts: plane.effectiveKw / SolarLayoutDetector.derate * 100,
                azimuthDegrees: plane.azimuth, tiltDegrees: plane.tilt)])
    }
    return ManualSolarLayout(systems: systems)
}
