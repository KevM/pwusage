import Foundation

enum MobileSolarHistoryResponse: Decodable, Equatable, Sendable {
    case disabled
    case enabled(timeZone: TimeZone, days: [MobileSolarHistoryDay], nextFrom: String?)
    private enum CodingKeys: String, CodingKey { case version, enabled, timeZone, days, nextFrom }
    init(from decoder: Decoder) throws {
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
        self = try .enabled(timeZone: timeZone, days: values.decode([MobileSolarHistoryDay].self, forKey: .days),
                            nextFrom: values.decodeIfPresent(String.self, forKey: .nextFrom))
    }
}

struct MobileSolarHistoryDay: Decodable, Equatable, Sendable {
    enum Status: String, Decodable, Equatable, Sendable { case open, complete, gapped, empty }
    let day: String
    let dayStart: Date
    let status: Status
    let fetchedAt: Date?
    let solarWh: [Double?]

    init(day: String, dayStart: Date, status: Status, fetchedAt: Date?, solarWh: [Double?]) {
        self.day = day
        self.dayStart = dayStart
        self.status = status
        self.fetchedAt = fetchedAt
        self.solarWh = solarWh
    }

    private enum CodingKeys: String, CodingKey { case day, dayStart, status, fetchedAt, solarWh }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        day = try values.decode(String.self, forKey: .day)
        dayStart = try values.decode(Date.self, forKey: .dayStart)
        status = try values.decode(Status.self, forKey: .status)
        fetchedAt = try values.decodeIfPresent(Date.self, forKey: .fetchedAt)
        solarWh = try values.decode([Double?].self, forKey: .solarWh)
        guard [276, 288, 300].contains(solarWh.count),
              solarWh.compactMap({ $0 }).allSatisfy(\.isFinite) else {
            throw DecodingError.dataCorruptedError(
                forKey: .solarWh, in: values, debugDescription: "Invalid solar slots")
        }
    }
}

protocol MobileSolarHistoryDataAPI: Sendable {
    func fetchSolarHistory(siteID: String, from: String, changedSince: Date?) async throws -> MobileSolarHistoryResponse
}
