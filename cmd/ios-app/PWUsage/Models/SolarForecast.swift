import Foundation

struct SolcastSite: Decodable, Equatable, Sendable {
    let resourceID: String
    let name: String
    let tags: [String]

    enum CodingKeys: String, CodingKey {
        case resourceID = "resource_id"
        case name
        case tags
    }

    init(resourceID: String, name: String, tags: [String]) {
        self.resourceID = resourceID
        self.name = name
        self.tags = tags
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        resourceID = try values.decode(String.self, forKey: .resourceID)
        name = try values.decode(String.self, forKey: .name)
        tags = try values.decodeIfPresent([String].self, forKey: .tags) ?? []
    }
}

struct SolcastSitesResponse: Decodable, Equatable, Sendable {
    let sites: [SolcastSite]
}

struct SolcastForecastResponse: Decodable, Equatable, Sendable {
    let forecasts: [SolcastForecastPoint]
}

struct SolcastForecastPoint: Decodable, Equatable, Sendable {
    let periodEnd: Date
    let periodDuration: TimeInterval
    let pvEstimateKw: Double
    let pvEstimate10Kw: Double?
    let pvEstimate90Kw: Double?

    enum CodingKeys: String, CodingKey {
        case periodEnd = "period_end"
        case period
        case pvEstimate = "pv_estimate"
        case pvEstimate10 = "pv_estimate10"
        case pvEstimate90 = "pv_estimate90"
    }

    init(periodEnd: Date, periodDuration: TimeInterval, pvEstimateKw: Double, pvEstimate10Kw: Double?, pvEstimate90Kw: Double?) {
        self.periodEnd = periodEnd
        self.periodDuration = periodDuration
        self.pvEstimateKw = pvEstimateKw
        self.pvEstimate10Kw = pvEstimate10Kw
        self.pvEstimate90Kw = pvEstimate90Kw
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        periodEnd = try values.decode(SolcastTimestamp.self, forKey: .periodEnd).date
        periodDuration = try SolcastPeriod.parse(values.decode(String.self, forKey: .period))
        pvEstimateKw = try Self.finiteEstimate(from: values, forKey: .pvEstimate, required: true) ?? 0
        pvEstimate10Kw = try Self.finiteEstimate(from: values, forKey: .pvEstimate10, required: false)
        pvEstimate90Kw = try Self.finiteEstimate(from: values, forKey: .pvEstimate90, required: false)
        guard periodDuration > 0, pvEstimateKw >= 0,
              pvEstimate10Kw.map({ $0 >= 0 }) ?? true,
              pvEstimate90Kw.map({ $0 >= 0 }) ?? true else {
            throw DecodingError.dataCorruptedError(forKey: .pvEstimate, in: values, debugDescription: "Invalid Solcast forecast value")
        }
    }

    var periodStart: Date { periodEnd.addingTimeInterval(-periodDuration) }
    func energyKwh() throws -> Double {
        let energy = pvEstimateKw * (periodDuration / 3600)
        guard periodDuration.isFinite, periodDuration > 0, pvEstimateKw.isFinite, pvEstimateKw >= 0, energy.isFinite else {
            throw SolarForecastError.nonFiniteValue
        }
        return energy
    }

    private static func finiteEstimate(from values: KeyedDecodingContainer<CodingKeys>, forKey key: CodingKeys, required: Bool) throws -> Double? {
        guard values.contains(key), try !values.decodeNil(forKey: key) else {
            if required {
                throw DecodingError.keyNotFound(key, DecodingError.Context(codingPath: values.codingPath, debugDescription: "Required forecast estimate is missing"))
            }
            return nil
        }
        let value = try values.decode(Double.self, forKey: key)
        guard value.isFinite else {
            throw DecodingError.dataCorruptedError(forKey: key, in: values, debugDescription: "Forecast estimate must be finite")
        }
        // Solcast's hobbyist rooftop endpoint reports `pv_estimate` in MW, per its
        // published output-parameter table. Everything downstream works in kW, so
        // convert once here rather than scattering a factor through the maths.
        let kilowatts = value * 1000
        guard kilowatts.isFinite else {
            throw DecodingError.dataCorruptedError(forKey: key, in: values, debugDescription: "Forecast estimate is out of range once converted to kilowatts")
        }
        return kilowatts
    }
}

private struct SolcastTimestamp: Decodable {
    let date: Date

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        guard let date = Self.parse(value) else {
            throw DecodingError.dataCorruptedError(in: try decoder.singleValueContainer(), debugDescription: "Invalid UTC timestamp")
        }
        self.date = date
    }

    private static func parse(_ value: String) -> Date? {
        for options: ISO8601DateFormatter.Options in [
            [.withInternetDateTime, .withFractionalSeconds],
            [.withInternetDateTime]
        ] {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = options
            if let date = formatter.date(from: value) { return date }
        }
        return nil
    }
}

private enum SolcastPeriod {
    static func parse(_ value: String) throws -> TimeInterval {
        guard value.hasPrefix("PT") else { throw error(value) }
        let components = value.dropFirst(2)
        var number = ""
        var seconds: TimeInterval = 0
        for character in components {
            if character.isNumber || character == "." {
                number.append(character)
                continue
            }
            guard let amount = Double(number), amount.isFinite else { throw error(value) }
            switch character {
            case "H": seconds += amount * 3600
            case "M": seconds += amount * 60
            case "S": seconds += amount
            default: throw error(value)
            }
            number = ""
        }
        guard number.isEmpty, seconds > 0, seconds.isFinite else { throw error(value) }
        return seconds
    }

    private static func error(_ value: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: [], debugDescription: "Invalid Solcast period duration: \(value)"))
    }
}

struct SolarForecastInterval: Codable, Equatable, Sendable {
    let periodStart: Date
    let periodEnd: Date
    let powerKw: Double
    func energyKwh() throws -> Double {
        let duration = periodEnd.timeIntervalSince(periodStart)
        let energy = powerKw * (duration / 3600)
        guard periodStart.timeIntervalSince1970.isFinite, periodEnd.timeIntervalSince1970.isFinite,
              duration.isFinite, duration > 0, powerKw.isFinite, powerKw >= 0, energy.isFinite else {
            throw SolarForecastError.nonFiniteValue
        }
        return energy
    }
}

enum SolarForecastError: Error, Equatable {
    case duplicateInterval
    case incompleteCoverage
    case nonFiniteValue
}

enum SolarForecast {
    static func combine(_ selectedArrays: [[SolcastForecastPoint]]) throws -> [SolarForecastInterval] {
        guard let first = selectedArrays.first, !first.isEmpty else { throw SolarForecastError.incompleteCoverage }
        var firstByInterval: [IntervalKey: SolcastForecastPoint] = [:]
        for point in first {
            guard point.periodEnd.timeIntervalSince1970.isFinite,
                  point.periodStart.timeIntervalSince1970.isFinite,
                  point.periodEnd > point.periodStart,
                  point.periodDuration.isFinite, point.periodDuration > 0,
                  point.pvEstimateKw.isFinite, point.pvEstimateKw >= 0 else {
                throw SolarForecastError.nonFiniteValue
            }
            let key = IntervalKey(start: point.periodStart, end: point.periodEnd)
            guard firstByInterval.updateValue(point, forKey: key) == nil else { throw SolarForecastError.duplicateInterval }
        }
        try validateNoOverlap(firstByInterval.keys)
        let expectedKeys = Set(firstByInterval.keys)

        var summedPower = Dictionary(uniqueKeysWithValues: expectedKeys.map { ($0, 0.0) })
        for array in selectedArrays {
            guard !array.isEmpty else { throw SolarForecastError.incompleteCoverage }
            var points: [IntervalKey: SolcastForecastPoint] = [:]
            for point in array {
                guard point.periodEnd.timeIntervalSince1970.isFinite,
                      point.periodStart.timeIntervalSince1970.isFinite,
                      point.periodEnd > point.periodStart,
                      point.periodDuration.isFinite, point.periodDuration > 0,
                      point.pvEstimateKw.isFinite, point.pvEstimateKw >= 0 else {
                    throw SolarForecastError.nonFiniteValue
                }
                let key = IntervalKey(start: point.periodStart, end: point.periodEnd)
                guard points.updateValue(point, forKey: key) == nil else { throw SolarForecastError.duplicateInterval }
            }
            try validateNoOverlap(points.keys)
            guard Set(points.keys) == expectedKeys else { throw SolarForecastError.incompleteCoverage }
            for (key, point) in points {
                let total = summedPower[key, default: 0] + point.pvEstimateKw
                guard total.isFinite else { throw SolarForecastError.nonFiniteValue }
                summedPower[key] = total
            }
        }
        let intervals = summedPower.map { key, power in
            SolarForecastInterval(periodStart: key.start, periodEnd: key.end, powerKw: power)
        }.sorted { $0.periodStart < $1.periodStart }
        for interval in intervals { _ = try interval.energyKwh() }
        return intervals
    }

    static func energy(in intervals: [SolarForecastInterval], from start: Date, to end: Date) throws -> Double {
        guard start.timeIntervalSince1970.isFinite, end.timeIntervalSince1970.isFinite else {
            throw SolarForecastError.nonFiniteValue
        }
        guard start < end else { throw SolarForecastError.incompleteCoverage }
        let ordered = intervals.filter { $0.periodEnd > start && $0.periodStart < end }.sorted { $0.periodStart < $1.periodStart }
        guard ordered.allSatisfy({
            $0.periodStart.timeIntervalSince1970.isFinite && $0.periodEnd.timeIntervalSince1970.isFinite &&
                $0.periodStart < $0.periodEnd && $0.powerKw.isFinite && $0.powerKw >= 0
        }) else {
            throw SolarForecastError.nonFiniteValue
        }
        try validateNoOverlap(ordered.map { IntervalKey(start: $0.periodStart, end: $0.periodEnd) })
        var cursor = start
        var energy = 0.0
        for interval in ordered where interval.periodEnd > cursor && interval.periodStart < end {
            guard interval.periodStart <= cursor else { throw SolarForecastError.incompleteCoverage }
            let overlapEnd = min(interval.periodEnd, end)
            guard overlapEnd > cursor else { continue }
            let segmentEnergy = interval.powerKw * (overlapEnd.timeIntervalSince(cursor) / 3600)
            guard segmentEnergy.isFinite else { throw SolarForecastError.nonFiniteValue }
            energy += segmentEnergy
            guard energy.isFinite else { throw SolarForecastError.nonFiniteValue }
            cursor = overlapEnd
            if cursor == end { return energy }
        }
        throw SolarForecastError.incompleteCoverage
    }

    private static func validateNoOverlap<S: Sequence>(_ keys: S) throws where S.Element == IntervalKey {
        let sorted = Array(keys).sorted { $0.start < $1.start }
        for pair in zip(sorted, sorted.dropFirst()) where pair.0.end > pair.1.start {
            throw SolarForecastError.incompleteCoverage
        }
    }
}

private struct IntervalKey: Hashable {
    let start: Date
    let end: Date
}
