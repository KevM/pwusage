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

/// A rough size for a custom job, so it can be set by feel; bigger sizes take bigger steps.
enum JobSize: String, Codable, CaseIterable, Equatable {
    case small
    case medium
    case large

    var title: String {
        switch self {
        case .small: "Small"
        case .medium: "Medium"
        case .large: "Large"
        }
    }

    var defaultEnergyKwh: Double {
        switch self {
        case .small: 1.5
        case .medium: 6
        case .large: 20
        }
    }

    var energyStepKwh: Double {
        switch self {
        case .small: 0.5
        case .medium: 1
        case .large: 5
        }
    }

    var defaultDurationHours: Double {
        switch self {
        case .small: 1
        case .medium: 2
        case .large: 4
        }
    }
}

struct LoadProfile: Codable, Equatable, Identifiable {
    /// Validation ceiling for a car battery, set generously so real EVs fit and
    /// typos are rejected. It is not a forecast-horizon bound: the estimator
    /// searches to the end of tomorrow and can chart a run that finishes later.
    static let maximumCarCapacityKwh = 200.0

    let id: String
    var name: String
    let kind: LoadProfileKind
    var energyKwh: Double
    var durationHours: Double
    var carSettings: CarLoadSettings?
    /// Custom jobs only; nil for jobs set with exact kWh and hours.
    var size: JobSize?
    /// The word Smart Shift uses for starting this job ("Wash", "Heat"); nil falls back to the job's kind.
    var actionVerb: String?
}

/// Everything needed to add a job; the store assigns the id.
struct NewProfile {
    var name: String
    var kind: LoadProfileKind
    var energyKwh: Double
    var durationHours: Double
    var carSettings: CarLoadSettings?
    var size: JobSize?
    var actionVerb: String?

    init(name: String, kind: LoadProfileKind, energyKwh: Double, durationHours: Double,
         carSettings: CarLoadSettings? = nil, size: JobSize? = nil, actionVerb: String? = nil) {
        self.name = name
        self.kind = kind
        self.energyKwh = energyKwh
        self.durationHours = durationHours
        self.carSettings = carSettings
        self.size = size
        self.actionVerb = actionVerb
    }
}

/// An edit to a saved job. A nil name, car settings, size or verb leaves that field as it is.
struct ProfileEdit {
    var name: String?
    var energyKwh: Double
    var durationHours: Double
    var carSettings: CarLoadSettings?
    var size: JobSize?
    var actionVerb: String?

    init(name: String? = nil, energyKwh: Double, durationHours: Double, carSettings: CarLoadSettings? = nil,
         size: JobSize? = nil, actionVerb: String? = nil) {
        self.name = name
        self.energyKwh = energyKwh
        self.durationHours = durationHours
        self.carSettings = carSettings
        self.size = size
        self.actionVerb = actionVerb
    }
}

enum LoadProfileError: Error, Equatable, LocalizedError {
    case invalidProfile
    case profileNotFound

    var errorDescription: String? {
        switch self {
        case .invalidProfile:
            return "Enter a name, and energy and duration greater than zero. "
                + "Check the car charge settings too."
        case .profileNotFound:
            return "That load profile is no longer available. Close and reopen load profiles."
        }
    }
}
