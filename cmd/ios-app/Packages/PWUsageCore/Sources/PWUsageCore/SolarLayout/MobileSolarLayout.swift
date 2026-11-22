import Foundation

/// One detected panel face. Azimuth is compass degrees (90 = east), tilt is from horizontal.
public struct SolarLayoutPlane: Codable, Equatable, Hashable, Sendable {
    public let azimuth: Double
    public let tilt: Double
    public let dcKwp: Double

    public init(azimuth: Double, tilt: Double, dcKwp: Double) {
        self.azimuth = azimuth
        self.tilt = tilt
        self.dcKwp = dcKwp
    }

    public var isValid: Bool {
        azimuth.isFinite && (0 ... 360).contains(azimuth)
            && tilt.isFinite && (0 ... 90).contains(tilt)
            && dcKwp.isFinite && dcKwp > 0
    }
}

public enum SolarLayoutConfidence: String, Codable, Sendable { case high, medium }

/// Where the home location came from. Admin-seeded locations are ZIP or town centres
/// (`estimated`); a server without the field predates that seeding, so it means `device`.
/// `searched` (an address or ZIP code the user chose) and `map` (a pin they placed) are set on
/// the phone; an older app reading them from iCloud falls back to `device`.
public enum SolarLocationSource: String, Codable, Sendable {
    case estimated, device, searched, map

    /// Chosen by the user rather than seeded.
    public var isExact: Bool { self != .estimated }
}

public struct SolarHomeLocation: Codable, Equatable, Hashable, Sendable {
    public let latitude: Double
    public let longitude: Double
    public let source: SolarLocationSource

    public init(latitude: Double, longitude: Double, source: SolarLocationSource) {
        self.latitude = latitude
        self.longitude = longitude
        self.source = source
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        latitude = try values.decode(Double.self, forKey: .latitude)
        longitude = try values.decode(Double.self, forKey: .longitude)
        source = try values.decodeIfPresent(SolarLocationSource.self, forKey: .source) ?? .device
        guard isValid else {
            throw DecodingError.dataCorruptedError(
                forKey: .latitude, in: values, debugDescription: "Invalid coordinates")
        }
    }

    public var isValid: Bool {
        latitude.isFinite && (-90 ... 90).contains(latitude) && longitude.isFinite && (-180 ... 180).contains(longitude)
    }

    public var rounded: SolarHomeLocation {
        SolarHomeLocation(
            latitude: latitude.roundedToHundredths,
            longitude: longitude.roundedToHundredths,
            source: source
        )
    }

    public func sharesCoordinates(with other: SolarHomeLocation?) -> Bool {
        guard let other else { return false }
        return latitude == other.latitude && longitude == other.longitude
    }
}

public func solarLocationsShareCoordinates(_ lhs: SolarHomeLocation?, _ rhs: SolarHomeLocation?) -> Bool {
    guard let lhs, let rhs else { return false }
    return lhs.latitude == rhs.latitude && lhs.longitude == rhs.longitude
}

public struct SolarLayout: Codable, Equatable, Sendable {
    public let planes: [SolarLayoutPlane]
    public let acClipKw: Double?
    public let confidence: SolarLayoutConfidence
    public let detectedAt: Date?
    /// Built from faces the owner entered, not fitted. Entered faces are known, so the detector's
    /// three-plane limit does not apply. Never serialized: it is derived on the phone.
    public let isManual: Bool

    private enum CodingKeys: String, CodingKey { case planes, acClipKw, confidence, detectedAt }

    public init(
        planes: [SolarLayoutPlane], acClipKw: Double?, confidence: SolarLayoutConfidence, detectedAt: Date?,
        isManual: Bool = false
    ) {
        self.planes = planes
        self.acClipKw = acClipKw
        self.confidence = confidence
        self.detectedAt = detectedAt
        self.isManual = isManual
    }

    /// One to three planes for a detected layout, any number for an entered one.
    public var hasValidPlaneCount: Bool { isManual ? !planes.isEmpty : (1 ... 3).contains(planes.count) }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        planes = try values.decode([SolarLayoutPlane].self, forKey: .planes)
        acClipKw = try values.decodeIfPresent(Double.self, forKey: .acClipKw)
        confidence = try values.decode(SolarLayoutConfidence.self, forKey: .confidence)
        detectedAt = try values.decodeIfPresent(Date.self, forKey: .detectedAt)
        isManual = false
        guard (1 ... 3).contains(planes.count), planes.allSatisfy(\.isValid),
              acClipKw.map({ $0.isFinite && $0 > 0 }) ?? true else {
            throw DecodingError.dataCorruptedError(
                forKey: .planes, in: values, debugDescription: "Invalid solar layout")
        }
    }
}

public enum MobileSolarLayoutReason: String, Codable, Sendable {
    case needsLocation = "needs-location"
    case pending
    case notEnoughHistory = "not-enough-history"
    case lowConfidence = "low-confidence"
}

/// The automatic forecast's layout state, built on the phone from the local layout record (it was
/// once `GET /api/mobile/solar-layout`, version 1). Disabled is retained for compatibility with an
/// older server that cannot provide solar history.
public enum MobileSolarLayoutResponse: Decodable, Equatable, Sendable {
    case disabled
    case enabled(location: SolarHomeLocation?, layout: SolarLayout?, reason: MobileSolarLayoutReason?)

    private enum CodingKeys: String, CodingKey { case version, enabled, location, layout, reason }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard try values.decode(Int.self, forKey: .version) == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .version, in: values, debugDescription: "Unsupported version")
        }
        guard try values.decode(Bool.self, forKey: .enabled) else {
            self = .disabled
            return
        }
        self = try .enabled(
            location: values.decodeIfPresent(SolarHomeLocation.self, forKey: .location),
            layout: values.decodeIfPresent(SolarLayout.self, forKey: .layout),
            reason: values.decodeIfPresent(MobileSolarLayoutReason.self, forKey: .reason)
        )
    }
}

public struct MobileSolarActualsHour: Decodable, Equatable, Sendable {
    public let hourStart: Date
    /// Energy in the hour, not power.
    public let energyWh: Double
    /// All twelve five-minute samples are present.
    public let complete: Bool

    public init(hourStart: Date, energyWh: Double, complete: Bool) {
        self.hourStart = hourStart
        self.energyWh = energyWh
        self.complete = complete
    }

    private enum CodingKeys: String, CodingKey {
        case hourStart
        case energyWh = "wh"
        case complete
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        hourStart = try values.decode(Date.self, forKey: .hourStart)
        energyWh = try values.decode(Double.self, forKey: .energyWh)
        complete = try values.decode(Bool.self, forKey: .complete)
        guard energyWh.isFinite, energyWh >= 0 else {
            throw DecodingError.dataCorruptedError(forKey: .energyWh, in: values, debugDescription: "Invalid energy")
        }
    }
}

extension Double {
    /// Rounded to two decimals (~1 km), the only precision a home location leaves the device with.
    public var roundedToHundredths: Double { (self * 100).rounded() / 100 }
}
