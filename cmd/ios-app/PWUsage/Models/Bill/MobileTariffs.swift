import Foundation

struct MobileTariffsResponse: Codable, Equatable {
    let version: Int
    let site: Site
    let currency: String
    let asOf: Date
    let tariffs: [Tariff]

    struct Site: Codable, Equatable {
        let id: String
        let name: String
        let timezone: String
    }
    struct Tariff: Codable, Equatable, Identifiable {
        let id: Int
        let name: String
        let seasons: [Season]
    }
    struct Season: Codable, Equatable, Identifiable {
        let id: Int
        let name: String
        let dates: String
        let isActive: Bool
        let periods: [Period]
    }
    struct Period: Codable, Equatable, Identifiable {
        let id: Int
        let name: String
        let days: String
        let times: String
        let buyRate: Double?
        let sellRate: Double?
        let isActive: Bool
    }

    func validating(siteID: String) throws -> Self {
        let ratesAreFinite = tariffs.allSatisfy { tariff in
            tariff.seasons.allSatisfy { season in
                season.periods.allSatisfy { ($0.buyRate?.isFinite ?? true) && ($0.sellRate?.isFinite ?? true) }
            }
        }
        // Finiteness only: negative rates are real tariffs.
        guard version == 1, site.id == siteID, TimeZone(identifier: site.timezone) != nil, ratesAreFinite else {
            throw PWUsageAPIError.invalidResponse
        }
        return self
    }

    func activityIsCurrent(now: Date) -> Bool {
        // The server resolves minute-level boundaries; don't carry markers into
        // the next minute while the next response is still on the wire.
        now >= asOf && Int(now.timeIntervalSince1970 / 60) == Int(asOf.timeIntervalSince1970 / 60)
    }

    func activeSummary(now: Date) -> String? {
        guard activityIsCurrent(now: now) else { return nil }
        for tariff in tariffs {
            for season in tariff.seasons where season.isActive {
                if let period = season.periods.first(where: \.isActive) {
                    return "\(season.name) · \(period.name)"
                }
            }
        }
        return nil
    }
}

@MainActor
protocol MobileTariffDataAPI: Sendable {
    func fetchTariffs(siteID: String) async throws -> MobileTariffsResponse
}
