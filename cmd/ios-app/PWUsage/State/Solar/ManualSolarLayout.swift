import Foundation

/// The solar installation as the owner describes it. A site holds any number of systems and each
/// system any number of faces: entered faces are known, not fitted, so the detector's three-plane
/// limit does not apply here.
struct ManualSolarLayout: Codable, Equatable, Sendable {
    var systems: [ManualSolarSystem]
}

/// One installation with its own age, panels and inverter.
struct ManualSolarSystem: Codable, Equatable, Sendable, Identifiable {
    var id = UUID()
    var label: String?
    /// Month and year the system started producing; drives that system's expected aging.
    var installDate: Date?
    /// The inverter's AC rating, which marks where this system clips.
    var inverterAcKw: Double?
    var faces: [ManualSolarFace]
}

/// One roof plane of a system.
struct ManualSolarFace: Codable, Equatable, Sendable, Identifiable {
    var id = UUID()
    var label: String?
    var panelCount: Int
    /// Per face: older systems have lower-wattage panels.
    var panelWatts: Double
    /// Falls back to the detected plane's value when nil.
    var azimuthDegrees: Double?
    var tiltDegrees: Double?
}
