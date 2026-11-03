import Foundation

/// One `POST /api/mobile/solar-history` answer: the server asked Tesla for the slice's missing days
/// and returns what it now stores for them.
struct MobileSolarHistoryFill: Equatable, Sendable {
    enum Status: String, Decodable, Equatable, Sendable {
        /// Every day of the slice is stored or settled: the slice need not be asked for again.
        case complete
        /// The server's budget ran out; asking again continues where it stopped.
        case partial
        /// Another import holds the site's lock.
        case busy
    }

    let timeZone: TimeZone
    let status: Status
    /// The first site-local day that can hold data (installation or the backfill boundary).
    let historyStart: String
    let days: [MobileSolarHistoryDay]
}

enum MobileSolarHistoryFillResponse: Decodable, Equatable, Sendable {
    case disabled
    case enabled(MobileSolarHistoryFill)

    private enum CodingKeys: String, CodingKey { case version, enabled, timeZone, status, historyStart, days }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard try values.decode(Int.self, forKey: .version) == 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .version, in: values, debugDescription: "Unsupported version")
        }
        guard try values.decode(Bool.self, forKey: .enabled) else { self = .disabled; return }
        guard let timeZone = try TimeZone(identifier: values.decode(String.self, forKey: .timeZone)) else {
            throw DecodingError.dataCorruptedError(forKey: .timeZone, in: values, debugDescription: "Invalid time zone")
        }
        let days = try values.decode([MobileSolarHistoryDay].self, forKey: .days)
        guard MobileSolarHistoryDay.slotsMatchDays(days, timeZone: timeZone) else {
            throw DecodingError.dataCorruptedError(
                forKey: .days, in: values, debugDescription: "Solar slot count must match the site-local day duration")
        }
        self = try .enabled(MobileSolarHistoryFill(
            timeZone: timeZone, status: values.decode(MobileSolarHistoryFill.Status.self, forKey: .status),
            historyStart: values.decode(String.self, forKey: .historyStart), days: days))
    }
}

/// Fill failures the caller schedules around instead of treating as a failed import.
enum MobileSolarHistoryFillError: Error, Equatable {
    /// Tesla is limiting requests until `retryAt`. `isFallback` when Tesla named no wait.
    case rateLimited(retryAt: Date, isFallback: Bool)
    /// The account's Tesla token refresh is backing off until `retryAt`.
    case teslaUnavailable(retryAt: Date)
    /// The Tesla connection must be renewed before history can be imported.
    case teslaReconnectRequired

    /// Wait assumed when a throttle names no deadline (mirrors the server's fallback).
    static let fallbackWait: TimeInterval = 60
}

protocol MobileSolarHistoryFillAPI: Sendable {
    /// Ask the server to fill complete site-local days `[from, from + days)`, `days` 1...3.
    func fillSolarHistory(siteID: String, from: String, days: Int) async throws -> MobileSolarHistoryFillResponse
}
