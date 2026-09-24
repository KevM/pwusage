import Foundation

struct MobileSite: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    let utility: String
}

struct MobileLiveResponse: Decodable, Equatable {
    let version: Int
    let site: Site
    let live: Live
    let stateOfCharge: Double?
    let activeTariff: String?
    let today: Today
    let todayComplete: Bool
    let currentBill: Bill?
    let sources: Sources

    struct Site: Decodable, Equatable {
        let id: String
        let name: String
        let timezone: String
        let localDate: String
    }

    struct Live: Decodable, Equatable {
        let solarPower: Double
        let loadPower: Double
        let batteryPower: Double
        let gridPower: Double
    }

    struct Today: Decodable, Equatable {
        let homeKwh: Double
        let solarKwh: Double
        let gridNetKwh: Double
        let batteryNetKwh: Double
    }

    struct Bill: Decodable, Equatable {
        let estimatedCost: Double?
        let currency: String
        let cycleStart: Date
        let cycleEnd: Date
        let periods: [Period]
    }

    struct Sources: Decodable, Equatable {
        let liveStatusAt: Date?
        let energyDataThrough: Date?
        let stateOfChargeAt: Date?
    }

    enum ContractError: Error, Equatable {
        case unsupportedVersion(Int)
    }

    private enum CodingKeys: String, CodingKey { case version, site, live, stateOfCharge, activeTariff, today, todayComplete, currentBill, sources }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .version)
        guard version == 1 else { throw ContractError.unsupportedVersion(version) }
        self.version = version
        site = try container.decode(Site.self, forKey: .site)
        live = try container.decode(Live.self, forKey: .live)
        stateOfCharge = try container.decodeIfPresent(Double.self, forKey: .stateOfCharge)
        activeTariff = try container.decodeIfPresent(String.self, forKey: .activeTariff)
        today = try container.decode(Today.self, forKey: .today)
        todayComplete = try container.decode(Bool.self, forKey: .todayComplete)
        currentBill = try container.decodeIfPresent(Bill.self, forKey: .currentBill)
        sources = try container.decode(Sources.self, forKey: .sources)
    }
}

struct MobileBillResponse: Decodable, Equatable {
    let version: Int
    let site: Site
    let currentBill: Bill
    let sources: Sources

    struct Site: Decodable, Equatable {
        let id: String
        let name: String
        let timezone: String
    }

    struct Bill: Decodable, Equatable {
        let estimatedCost: Double?
        let currency: String
        let cycleStart: Date
        let cycleEnd: Date
        let periods: [Period]
    }

    struct Sources: Decodable, Equatable {
        let calculatedAt: Date
        let energyDataThrough: Date?
    }

    enum ContractError: Error, Equatable {
        case unsupportedVersion(Int)
        case siteMismatch(expected: String, actual: String)
    }

    private enum CodingKeys: String, CodingKey { case version, site, currentBill, sources }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .version)
        guard version == 1 else { throw ContractError.unsupportedVersion(version) }
        self.version = version
        site = try container.decode(Site.self, forKey: .site)
        currentBill = try container.decode(Bill.self, forKey: .currentBill)
        sources = try container.decode(Sources.self, forKey: .sources)
    }

    func validating(siteID: String) throws -> Self {
        guard site.id == siteID else {
            throw ContractError.siteMismatch(expected: siteID, actual: site.id)
        }
        return self
    }
}

struct Period: Decodable, Equatable {
    let tariffName: String
    let periodName: String
    let netGridKwh: Double
    let cost: Double
}

enum MobileContractDecoder {
    static func make() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = ISO8601DateFormatter.parse(value) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid ISO-8601 timestamp: \(value)")
            }
            return date
        }
        return decoder
    }
}

private extension ISO8601DateFormatter {
    static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }
}
