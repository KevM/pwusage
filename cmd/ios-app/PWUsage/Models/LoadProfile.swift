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
}

enum LoadProfileError: Error, Equatable, LocalizedError {
    case invalidProfile
    case profileNotFound
    case cannotDeleteBuiltIn
    case cannotResetCustom

    var errorDescription: String? {
        switch self {
        case .invalidProfile:
            return "Enter a name for custom loads, and energy and duration greater than zero. Check the car charge settings too."
        case .profileNotFound:
            return "That load profile is no longer available. Close and reopen load profiles."
        case .cannotDeleteBuiltIn:
            return "Built-in load profiles can’t be deleted. Edit them instead, or reset them to their default settings."
        case .cannotResetCustom:
            return "Custom loads can’t be reset to defaults. Delete the load and add it again instead."
        }
    }
}
