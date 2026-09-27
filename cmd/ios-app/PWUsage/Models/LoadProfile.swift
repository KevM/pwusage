import Foundation

enum LoadProfileKind: String, Codable, Equatable {
    case car
    case appliance
    case custom
}

enum CarChargingLevel: String, Codable, Equatable {
    case level1
    case level2
}

struct CarLoadSettings: Codable, Equatable {
    var capacityKwh: Double
    var initialStateOfCharge: Double
    var targetStateOfCharge: Double
    var chargingLevel: CarChargingLevel
}

struct LoadProfile: Codable, Equatable, Identifiable {
    /// A full Level 1 charge at this capacity fits inside the seven-day tariff timeline.
    static let maximumCarCapacityKwh = 200.0

    let id: String
    var name: String
    let kind: LoadProfileKind
    var energyKwh: Double
    var durationHours: Double
    var carSettings: CarLoadSettings?

    var isBuiltIn: Bool { UUID(uuidString: id) == nil && id != "custom-example" }
}

enum LoadProfileError: Error, Equatable {
    case invalidProfile
    case profileNotFound
    case cannotDeleteBuiltIn
    case cannotResetCustom
}
