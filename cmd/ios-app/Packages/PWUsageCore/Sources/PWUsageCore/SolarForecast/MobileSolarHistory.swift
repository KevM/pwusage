import Foundation

public enum MobileSolarHistoryResponse: Decodable, Equatable, Sendable {
    case disabled
    case enabled(timeZone: TimeZone, days: [MobileSolarHistoryDay], nextFrom: String?)
    private enum CodingKeys: String, CodingKey { case version, enabled, timeZone, days, nextFrom }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard try values.decode(Int.self, forKey: .version) == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .version, in: values, debugDescription: "Unsupported version")
        }
        guard try values.decode(Bool.self, forKey: .enabled) else { self = .disabled; return }
        let zone = try values.decode(String.self, forKey: .timeZone)
        guard let timeZone = TimeZone(identifier: zone) else {
            throw DecodingError.dataCorruptedError(forKey: .timeZone, in: values, debugDescription: "Invalid time zone")
        }
        let days = try values.decode([MobileSolarHistoryDay].self, forKey: .days)
        guard MobileSolarHistoryDay.slotsMatchDays(days, timeZone: timeZone) else {
            throw DecodingError.dataCorruptedError(
                forKey: .days, in: values, debugDescription: "Solar slot count must match the site-local day duration")
        }
        self = try .enabled(timeZone: timeZone, days: days,
                            nextFrom: values.decodeIfPresent(String.self, forKey: .nextFrom))
    }
}

public struct MobileSolarHistoryDay: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Equatable, Sendable { case open, complete, gapped, empty }
    public let day: String
    public let dayStart: Date
    public let status: Status
    public let fetchedAt: Date?
    public let solarWh: [Double?]
    public let loadWh: [Double?]
    public let gridWh: [Double?]
    public let batteryWh: [Double?]
    public let batterySoc: [Double?]

    public init(
        day: String,
        dayStart: Date,
        status: Status,
        fetchedAt: Date?,
        solarWh: [Double?],
        loadWh: [Double?]? = nil,
        gridWh: [Double?]? = nil,
        batteryWh: [Double?]? = nil,
        batterySoc: [Double?]? = nil
    ) {
        self.day = day
        self.dayStart = dayStart
        self.status = status
        self.fetchedAt = fetchedAt
        self.solarWh = solarWh
        self.loadWh = loadWh ?? Array(repeating: nil, count: solarWh.count)
        self.gridWh = gridWh ?? Array(repeating: nil, count: solarWh.count)
        self.batteryWh = batteryWh ?? Array(repeating: nil, count: solarWh.count)
        self.batterySoc = batterySoc ?? Array(repeating: nil, count: solarWh.count)
    }

    private enum CodingKeys: String, CodingKey {
        case day, dayStart, status, fetchedAt, solarWh, loadWh, gridWh, batteryWh, batterySoc
    }

    /// Whether every day holds one 5-minute slot per slot of its site-local day (276/288/300 with DST).
    public static func slotsMatchDays(_ days: [MobileSolarHistoryDay], timeZone: TimeZone) -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return days.allSatisfy { day in
            guard let duration = calendar.dateInterval(of: .day, for: day.dayStart)?.duration else {
                return false
            }
            let expected = Double(day.solarWh.count) * 300
            return duration == expected
                && day.loadWh.count == day.solarWh.count
                && day.gridWh.count == day.solarWh.count
                && day.batteryWh.count == day.solarWh.count
                && day.batterySoc.count == day.solarWh.count
        }
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        day = try values.decode(String.self, forKey: .day)
        dayStart = try values.decode(Date.self, forKey: .dayStart)
        status = try values.decode(Status.self, forKey: .status)
        fetchedAt = try values.decodeIfPresent(Date.self, forKey: .fetchedAt)
        solarWh = try Self.decodeSeries(from: values, key: .solarWh)
        loadWh = try Self.decodeSeries(from: values, key: .loadWh)
        gridWh = try Self.decodeSeries(from: values, key: .gridWh)
        batteryWh = try Self.decodeSeries(from: values, key: .batteryWh)
        batterySoc = try Self.decodeSeries(from: values, key: .batterySoc)
        guard loadWh.count == solarWh.count,
              gridWh.count == solarWh.count,
              batteryWh.count == solarWh.count,
              batterySoc.count == solarWh.count else {
            throw DecodingError.dataCorruptedError(
                forKey: .solarWh, in: values, debugDescription: "Flow series must match solar slot count")
        }
    }

    private static func decodeSeries(
        from values: KeyedDecodingContainer<CodingKeys>,
        key: CodingKeys
    ) throws -> [Double?] {
        let series = try values.decode([Double?].self, forKey: key)
        guard series.compactMap(\.self).allSatisfy(\.isFinite) else {
            throw DecodingError.dataCorruptedError(
                forKey: key, in: values, debugDescription: "Invalid \(key.rawValue) slots")
        }
        return series
    }
}

public protocol MobileSolarHistoryDataAPI: Sendable {
    func fetchSolarHistory(siteID: String, from: String, changedSince: Date?) async throws -> MobileSolarHistoryResponse
}
