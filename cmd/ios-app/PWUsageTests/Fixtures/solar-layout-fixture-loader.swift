import Foundation

/// One stage-by-stage parity fixture written by `cmd/next-app/scripts/solar-layout-fixtures.ts`.
/// Every field is decoded, including the optional `selection` and `fit` stages, so later
/// parity tests only consume it.
struct SolarLayoutFixture: Decodable {
    let name: String
    let input: Input
    let stages: Stages
    let result: Result

    struct Input: Decodable {
        let latitude: Double
        let longitude: Double
        let timeZone: String
        let start: Date
        let stepMinutes: Int
        /// Five-minute production in Wh, decoded from the fixture's little-endian Float32 payload.
        let solarWh: [Float]

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: InputKeys.self)
            latitude = try container.decode(Double.self, forKey: .latitude)
            longitude = try container.decode(Double.self, forKey: .longitude)
            timeZone = try container.decode(String.self, forKey: .timeZone)
            start = try container.decode(Date.self, forKey: .start)
            stepMinutes = try container.decode(Int.self, forKey: .stepMinutes)
            let encoded = try container.decode(String.self, forKey: .solarWh)
            guard let bytes = Data(base64Encoded: encoded), bytes.count.isMultiple(of: 4) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .solarWh, in: container, debugDescription: "solarWh is not base64 Float32 data")
            }
            solarWh = stride(from: 0, to: bytes.count, by: 4).map { offset in
                let bits = UInt32(bytes[offset])
                    | UInt32(bytes[offset + 1]) << 8
                    | UInt32(bytes[offset + 2]) << 16
                    | UInt32(bytes[offset + 3]) << 24
                return Float(bitPattern: bits)
            }
        }
    }

    struct Stages: Decodable {
        let sun: [Sun]
        let poa: POA
        let selection: Selection?
        let fit: Fit?
    }

    /// Sun geometry at the sample's mid-interval instant; `ambientFactor` is sun.ts `tfac`.
    struct Sun: Decodable {
        let timestamp: Date
        let apparentZenith: Double
        let elevation: Double
        let azimuth: Double
        let dniExtra: Double
        let ghi: Double
        let dni: Double
        let dhi: Double
        let ambientFactor: Double
    }

    struct POA: Decodable {
        let planes: [Plane]
        /// Plane-of-array model output in kW, one per daylight sun row (JSON key `kw`).
        let kw: [Double] // swiftlint:disable:this identifier_name
    }

    struct Plane: Decodable {
        let azimuth: Double
        let tilt: Double
        let effectiveKw: Double
    }

    struct Shade: Decodable, Equatable {
        let azimuthFrom: Double
        let azimuthTo: Double
        let belowElevation: Double
    }

    struct Selection: Decodable {
        let producingDays: Int
        let clearDays: Int
        let selectedRows: Int
        let clipKw: Double?
        let shading: [Shade]
    }

    struct Fit: Decodable {
        let planeCount: Int
        /// Cross-validated NRMSE keyed by plane count (1, 2, 3).
        let cvNrmse: [Int: Double]
        let bestPlanes: [Plane]
    }

    /// The detector's `SolarLayoutResult`. Named distinctly from the app's `SolarLayout` types.
    struct Result: Decodable {
        let status: String
        let confidence: String?
        let reasons: [String]
        let planes: [ResultPlane]
        let acClipKw: Double?
        let historyDays: Int
        let clearDays: Int
        let firstDay: String?
        let lastDay: String?
        let shading: [Shade]
    }

    struct ResultPlane: Decodable {
        let azimuth: Double
        let tilt: Double
        let dcKwp: Double
        let effectiveKw: Double
        /// `[low, high]` in degrees.
        let azimuthRange90: [Double]
        /// `[low, high]` in degrees.
        let tiltRange90: [Double]
    }

    /// Loads `<name>.json` from the test bundle. Throws when the resource is missing, so a
    /// fixture that fails to bundle fails the suite loudly instead of passing vacuously.
    static func load(_ name: String) throws -> SolarLayoutFixture {
        guard let url = Bundle(for: FixtureBundleToken.self).url(forResource: name, withExtension: "json") else {
            throw LoadError.missingResource(name)
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = formatter.date(from: text) else {
                throw DecodingError.dataCorruptedError(
                    in: container, debugDescription: "Invalid ISO 8601 date \(text)")
            }
            return date
        }
        return try decoder.decode(SolarLayoutFixture.self, from: Data(contentsOf: url))
    }

    enum LoadError: Error, Equatable {
        case missingResource(String)
    }
}

private final class FixtureBundleToken {}

private enum InputKeys: String, CodingKey {
    case latitude, longitude, timeZone, start, stepMinutes, solarWh
}
