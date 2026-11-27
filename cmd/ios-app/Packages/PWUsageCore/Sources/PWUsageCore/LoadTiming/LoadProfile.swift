#if canImport(FoundationEssentials)
    import FoundationEssentials
#else
    import Foundation
#endif

public enum LoadProfileKind: String, Codable, Equatable, Sendable {
    case car
    case appliance
    case custom
}

public enum CarChargingLevel: String, Codable, Equatable, Sendable {
    case level1
    case level2
}

public struct CarLoadSettings: Codable, Equatable, Sendable {
    public var capacityKwh: Double
    public var initialStateOfCharge: Double
    public var targetStateOfCharge: Double
    public var chargingLevel: CarChargingLevel

    public init(
        capacityKwh: Double, initialStateOfCharge: Double,
        targetStateOfCharge: Double, chargingLevel: CarChargingLevel
    ) {
        self.capacityKwh = capacityKwh
        self.initialStateOfCharge = initialStateOfCharge
        self.targetStateOfCharge = targetStateOfCharge
        self.chargingLevel = chargingLevel
    }
}

/// A rough size for a custom job, so it can be set by feel; bigger sizes take bigger steps.
public enum JobSize: String, Codable, CaseIterable, Equatable, Sendable {
    case small
    case medium
    case large

    public var title: String {
        switch self {
        case .small: "Small"
        case .medium: "Medium"
        case .large: "Large"
        }
    }

    public var defaultEnergyKwh: Double {
        switch self {
        case .small: 1.5
        case .medium: 6
        case .large: 20
        }
    }

    public var energyStepKwh: Double {
        switch self {
        case .small: 0.5
        case .medium: 1
        case .large: 5
        }
    }

    public var defaultDurationHours: Double {
        switch self {
        case .small: 1
        case .medium: 2
        case .large: 4
        }
    }
}

public struct LoadProfile: Codable, Equatable, Identifiable, Sendable {
    /// Validation ceiling for a car battery, set generously so real EVs fit and
    /// typos are rejected. It is not a forecast-horizon bound: the estimator
    /// searches to the end of tomorrow and can chart a run that finishes later.
    public static let maximumCarCapacityKwh = 200.0

    public let id: String
    public var name: String
    public let kind: LoadProfileKind
    public var energyKwh: Double
    public var durationHours: Double
    public var carSettings: CarLoadSettings?
    /// Custom jobs only; nil for jobs set with exact kWh and hours.
    public var size: JobSize?
    /// The word Smart Shift uses for starting this job ("Wash", "Heat"); nil falls back to the job's kind.
    public var actionVerb: String?
    /// An SF Symbol name picked from the glyph gallery; nil falls back to the job's usual glyph.
    public var symbol: String?

    public init(
        id: String, name: String, kind: LoadProfileKind, energyKwh: Double, durationHours: Double,
        carSettings: CarLoadSettings? = nil, size: JobSize? = nil, actionVerb: String? = nil,
        symbol: String? = nil
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.energyKwh = energyKwh
        self.durationHours = durationHours
        self.carSettings = carSettings
        self.size = size
        self.actionVerb = actionVerb
        self.symbol = symbol
    }
}

/// Everything needed to add a job; the store assigns the id.
public struct NewProfile {
    public var name: String
    public var kind: LoadProfileKind
    public var energyKwh: Double
    public var durationHours: Double
    public var carSettings: CarLoadSettings?
    public var size: JobSize?
    public var actionVerb: String?
    public var symbol: String?

    public init(name: String, kind: LoadProfileKind, energyKwh: Double, durationHours: Double,
                carSettings: CarLoadSettings? = nil, size: JobSize? = nil, actionVerb: String? = nil,
                symbol: String? = nil) {
        self.name = name
        self.kind = kind
        self.energyKwh = energyKwh
        self.durationHours = durationHours
        self.carSettings = carSettings
        self.size = size
        self.actionVerb = actionVerb
        self.symbol = symbol
    }
}

/// An edit to a saved job. A nil name, car settings, size or verb leaves that field as it is.
public struct ProfileEdit {
    public var name: String?
    public var energyKwh: Double
    public var durationHours: Double
    public var carSettings: CarLoadSettings?
    public var size: JobSize?
    public var actionVerb: String?
    public var symbol: String?
    /// True when `size` should replace the saved one even if nil (turning a sized job back into an exact one).
    public var updatesSize: Bool

    public init(name: String? = nil, energyKwh: Double, durationHours: Double, carSettings: CarLoadSettings? = nil,
                size: JobSize? = nil, actionVerb: String? = nil, symbol: String? = nil, updatesSize: Bool = false) {
        self.name = name
        self.energyKwh = energyKwh
        self.durationHours = durationHours
        self.carSettings = carSettings
        self.size = size
        self.actionVerb = actionVerb
        self.symbol = symbol
        self.updatesSize = updatesSize
    }
}

public enum LoadProfileError: Error, Equatable, LocalizedError {
    case invalidProfile
    case profileNotFound

    public var errorDescription: String? {
        switch self {
        case .invalidProfile:
            return "Enter a name, and energy and duration greater than zero. "
                + "Check the car charge settings too."
        case .profileNotFound:
            return "That load profile is no longer available. Close and reopen load profiles."
        }
    }
}
