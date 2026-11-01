import Foundation

/// One detected panel face. Azimuth is compass degrees (90 = east), tilt is from horizontal.
struct SolarLayoutPlane: Codable, Equatable, Hashable, Sendable {
    let azimuth: Double
    let tilt: Double
    let dcKwp: Double

    var isValid: Bool {
        azimuth.isFinite && (0 ... 360).contains(azimuth)
            && tilt.isFinite && (0 ... 90).contains(tilt)
            && dcKwp.isFinite && dcKwp > 0
    }
}

enum SolarLayoutConfidence: String, Codable, Sendable { case high, medium }

/// Where the home location came from. Admin-seeded locations are ZIP or town centres
/// (`estimated`); a server without the field predates that seeding, so it means `device`.
enum SolarLocationSource: String, Codable, Sendable { case estimated, device }

struct SolarHomeLocation: Codable, Equatable, Hashable, Sendable {
    let latitude: Double
    let longitude: Double
    let source: SolarLocationSource

    init(latitude: Double, longitude: Double, source: SolarLocationSource) {
        self.latitude = latitude
        self.longitude = longitude
        self.source = source
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        latitude = try values.decode(Double.self, forKey: .latitude)
        longitude = try values.decode(Double.self, forKey: .longitude)
        source = try values.decodeIfPresent(SolarLocationSource.self, forKey: .source) ?? .device
        guard isValid else {
            throw DecodingError.dataCorruptedError(
                forKey: .latitude, in: values, debugDescription: "Invalid coordinates")
        }
    }

    var isValid: Bool {
        latitude.isFinite && (-90 ... 90).contains(latitude) && longitude.isFinite && (-180 ... 180).contains(longitude)
    }

    var rounded: SolarHomeLocation {
        SolarHomeLocation(
            latitude: latitude.roundedToHundredths,
            longitude: longitude.roundedToHundredths,
            source: source
        )
    }

    func sharesCoordinates(with other: SolarHomeLocation?) -> Bool {
        guard let other else { return false }
        return latitude == other.latitude && longitude == other.longitude
    }
}

func solarLocationsShareCoordinates(_ lhs: SolarHomeLocation?, _ rhs: SolarHomeLocation?) -> Bool {
    guard let lhs, let rhs else { return false }
    return lhs.latitude == rhs.latitude && lhs.longitude == rhs.longitude
}

struct SolarLayout: Codable, Equatable, Sendable {
    let planes: [SolarLayoutPlane]
    let acClipKw: Double?
    let confidence: SolarLayoutConfidence
    let detectedAt: Date?

    init(planes: [SolarLayoutPlane], acClipKw: Double?, confidence: SolarLayoutConfidence, detectedAt: Date?) {
        self.planes = planes
        self.acClipKw = acClipKw
        self.confidence = confidence
        self.detectedAt = detectedAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        planes = try values.decode([SolarLayoutPlane].self, forKey: .planes)
        acClipKw = try values.decodeIfPresent(Double.self, forKey: .acClipKw)
        confidence = try values.decode(SolarLayoutConfidence.self, forKey: .confidence)
        detectedAt = try values.decodeIfPresent(Date.self, forKey: .detectedAt)
        guard (1 ... 3).contains(planes.count), planes.allSatisfy(\.isValid),
              acClipKw.map({ $0.isFinite && $0 > 0 }) ?? true else {
            throw DecodingError.dataCorruptedError(
                forKey: .planes, in: values, debugDescription: "Invalid solar layout")
        }
    }
}

enum MobileSolarLayoutReason: String, Codable, Sendable {
    case needsLocation = "needs-location"
    case pending
    case notEnoughHistory = "not-enough-history"
    case lowConfidence = "low-confidence"
}

/// `GET /api/mobile/solar-layout`, version 1. Disabled means the account is not in the beta.
enum MobileSolarLayoutResponse: Decodable, Equatable, Sendable {
    case disabled
    case enabled(location: SolarHomeLocation?, layout: SolarLayout?, reason: MobileSolarLayoutReason?)

    private enum CodingKeys: String, CodingKey { case version, enabled, location, layout, reason }

    init(from decoder: Decoder) throws {
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

struct MobileSolarActualsHour: Decodable, Equatable, Sendable {
    let hourStart: Date
    /// Energy in the hour, not power.
    let energyWh: Double
    /// All twelve five-minute samples are present.
    let complete: Bool

    init(hourStart: Date, energyWh: Double, complete: Bool) {
        self.hourStart = hourStart
        self.energyWh = energyWh
        self.complete = complete
    }

    private enum CodingKeys: String, CodingKey {
        case hourStart
        case energyWh = "wh"
        case complete
    }

    init(from decoder: Decoder) throws {
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
    var roundedToHundredths: Double { (self * 100).rounded() / 100 }
}
