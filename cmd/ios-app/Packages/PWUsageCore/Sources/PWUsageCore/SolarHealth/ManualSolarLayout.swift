import Foundation

/// The solar installation as the owner describes it. A site holds any number of systems and each
/// system any number of faces: entered faces are known, not fitted, so the detector's three-plane
/// limit does not apply here.
public struct ManualSolarLayout: Codable, Equatable, Sendable {
    public var systems: [ManualSolarSystem]

    public init(systems: [ManualSolarSystem]) {
        self.systems = systems
    }
}

/// One installation with its own age, panels and inverter.
public struct ManualSolarSystem: Codable, Equatable, Sendable, Identifiable {
    public var id = UUID()
    public var label: String?
    /// Month and year the system started producing; drives that system's expected aging.
    public var installDate: Date?
    /// The inverter's AC rating, which marks where this system clips.
    public var inverterAcKw: Double?
    public var faces: [ManualSolarFace]

    public init(
        id: UUID = UUID(),
        label: String? = nil,
        installDate: Date? = nil,
        inverterAcKw: Double? = nil,
        faces: [ManualSolarFace]
    ) {
        self.id = id
        self.label = label
        self.installDate = installDate
        self.inverterAcKw = inverterAcKw
        self.faces = faces
    }
}

/// One roof plane of a system.
public struct ManualSolarFace: Codable, Equatable, Sendable, Identifiable {
    public var id = UUID()
    public var label: String?
    public var panelCount: Int
    /// Per face: older systems have lower-wattage panels.
    public var panelWatts: Double
    /// Falls back to the detected plane's value when nil.
    public var azimuthDegrees: Double?
    public var tiltDegrees: Double?

    public init(
        id: UUID = UUID(),
        label: String? = nil,
        panelCount: Int,
        panelWatts: Double,
        azimuthDegrees: Double? = nil,
        tiltDegrees: Double? = nil
    ) {
        self.id = id
        self.label = label
        self.panelCount = panelCount
        self.panelWatts = panelWatts
        self.azimuthDegrees = azimuthDegrees
        self.tiltDegrees = tiltDegrees
    }
}
