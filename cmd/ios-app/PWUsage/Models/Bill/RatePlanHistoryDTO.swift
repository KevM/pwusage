import Foundation

/// Offer to walk the owner through past rate plans; mirrors `EstimatesStatusDTO.historyGuide`.
struct RatePlanHistoryGuideDTO: Codable, Equatable, Sendable {
    let historyStart: String
    let fillThrough: String?
    let unconfirmedDays: Int
}

enum RatePlanKind: String, Codable, Sendable {
    case fixed
    case timeOfUse = "time_of_use"
}

struct RatePlanPeakWindowDTO: Decodable, Sendable, Equatable, Identifiable {
    let label: String
    let fromHour: Int
    let toHour: Int

    var id: String { label }
}

struct RatePlanHistoryPlanDTO: Decodable, Sendable, Equatable, Identifiable {
    let name: String
    let startDate: String
    let kind: RatePlanKind
    let isDefault: Bool
    let closest: Bool
    let lowRate: Double
    let highRate: Double
    let peakWindows: [RatePlanPeakWindowDTO]
    /// Label of the window closest to the Tesla plan (Time of Use only).
    let closestWindow: String?
    /// Fixed plans: the URDB label to save.
    let fixedLabel: String?

    /// Unique within a list: two rows can share a name when one Peak-hours option is priced apart.
    var id: String { fixedLabel ?? peakWindows.first?.label ?? name }
}

struct RatePlanHistoryYearDTO: Decodable, Sendable, Equatable, Identifiable {
    let year: Int
    let askDate: String
    let plans: [RatePlanHistoryPlanDTO]

    var id: Int { year }
}

struct RatePlanHistoryDTO: Decodable, Sendable, Equatable {
    let utilityName: String
    let historyStart: String
    let fillThrough: String?
    let teslaShape: RatePlanKind?
    let current: [RatePlanHistoryPlanDTO]
    /// Newest first.
    let years: [RatePlanHistoryYearDTO]
}

/// One confirmed past plan period; `to` is JSON `null` for the open (latest) period.
struct RatePlanHistoryPeriod: Encodable, Sendable, Equatable {
    let label: String
    let from: String
    let endDate: String?

    init(label: String, from: String, to endDate: String?) {
        self.label = label
        self.from = from
        self.endDate = endDate
    }

    private enum CodingKeys: String, CodingKey {
        case label, from
        case endDate = "to"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(label, forKey: .label)
        try container.encode(from, forKey: .from)
        try container.encode(endDate, forKey: .endDate)
    }
}

extension MobileTariffDataAPI {
    func rateHistory(siteID _: String) async throws -> RatePlanHistoryDTO {
        throw PWUsageAPIError.invalidResponse
    }

    func saveRateHistory(
        siteID _: String,
        periods _: [RatePlanHistoryPeriod]
    ) async throws -> SiteTariffsTimelineResponse {
        throw PWUsageAPIError.invalidResponse
    }
}
