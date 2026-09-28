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
    let activeLoadTiming: ActiveLoadTiming?
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

    private enum CodingKeys: String, CodingKey { case version, site, live, stateOfCharge, activeTariff, activeLoadTiming, today, todayComplete, currentBill, sources }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .version)
        guard version == 1 else { throw ContractError.unsupportedVersion(version) }
        self.version = version
        site = try container.decode(Site.self, forKey: .site)
        live = try container.decode(Live.self, forKey: .live)
        stateOfCharge = try container.decodeIfPresent(Double.self, forKey: .stateOfCharge)
        activeTariff = try container.decodeIfPresent(String.self, forKey: .activeTariff)
        activeLoadTiming = try container.decodeIfPresent(ActiveLoadTiming.self, forKey: .activeLoadTiming)
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
    let loadTiming: LoadTiming?
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

    private enum CodingKeys: String, CodingKey { case version, site, currentBill, loadTiming, sources }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .version)
        guard version == 1 else { throw ContractError.unsupportedVersion(version) }
        self.version = version
        site = try container.decode(Site.self, forKey: .site)
        currentBill = try container.decode(Bill.self, forKey: .currentBill)
        loadTiming = try container.decodeIfPresent(LoadTiming.self, forKey: .loadTiming)
        sources = try container.decode(Sources.self, forKey: .sources)
    }

    func validating(siteID: String) throws -> Self {
        guard site.id == siteID else {
            throw ContractError.siteMismatch(expected: siteID, actual: site.id)
        }
        return self
    }
}

struct MobileLoadPlanningContextResponse: Decodable, Equatable, Sendable {
    static let maximumAge: TimeInterval = 24 * 60 * 60

    let version: Int
    let site: Site
    let units: Units
    let asOf: Date
    let availability: Availability
    let unavailableReason: String?
    let usableDayCount: Int
    let historyStart: Date
    let historyEnd: Date
    let slots: [Slot]

    struct Site: Decodable, Equatable, Sendable {
        let id: String
        let timezone: String
    }

    struct Units: Decodable, Equatable, Sendable {
        let power: String
        let localMinute: String
    }

    enum Availability: String, Decodable, Equatable, Sendable {
        case available
        case unavailable
    }

    struct Slot: Decodable, Equatable, Sendable {
        let localMinute: Int
        let homeKw: Double?
        let batteryNetChargeKw: Double?
        let sampleCount: Int
        let coverage: Double
    }

    enum ContractError: Error, Equatable {
        case unsupportedVersion(Int)
        case siteMismatch(expected: String, actual: String)
        case invalidSource
    }

    func validating(siteID: String, now: Date) throws -> Self {
        let sourceAge = now.timeIntervalSince(asOf)
        guard version == 1 else { throw ContractError.unsupportedVersion(version) }
        guard site.id == siteID else { throw ContractError.siteMismatch(expected: siteID, actual: site.id) }
        guard units.power == "kW", units.localMinute == "minute-of-day",
              TimeZone(identifier: site.timezone) != nil,
              asOf.timeIntervalSince1970.isFinite,
              historyStart.timeIntervalSince1970.isFinite,
              historyEnd.timeIntervalSince1970.isFinite,
              historyStart < historyEnd,
              historyEnd <= asOf,
              sourceAge >= -(5 * 60),
              sourceAge <= Self.maximumAge,
              slots.count == 48,
              slots.enumerated().allSatisfy({ index, slot in
                  slot.localMinute == index * 30
                      && slot.sampleCount >= 0
                      && slot.coverage.isFinite && (0...1).contains(slot.coverage)
                      && slot.homeKw.map(\.isFinite) ?? true
                      && slot.batteryNetChargeKw.map(\.isFinite) ?? true
              }),
              availability != .available || (
                  usableDayCount >= 5
                      && slots.allSatisfy { slot in
                          guard slot.homeKw != nil || slot.batteryNetChargeKw != nil else { return true }
                          return slot.sampleCount >= 5 && slot.coverage >= 0.9
                      }
              ) else { throw ContractError.invalidSource }
        return self
    }

    var estimatorContext: LoadTimingForecastEstimator.PlanningContext? {
        guard availability == .available else { return nil }
        return LoadTimingForecastEstimator.PlanningContext(
            timeZone: site.timezone,
            slots: slots.map {
                LoadTimingForecastEstimator.PlanningSlot(
                    localMinute: $0.localMinute,
                    homeKw: $0.homeKw,
                    batteryNetChargeKw: $0.batteryNetChargeKw
                )
            },
            asOf: asOf
        )
    }
}

struct ActiveLoadTiming: Decodable, Equatable {
    let periodName: String
    let buyRate: Double
    let sellRate: Double
    let marginalCost: Double?
    let basis: String
    let balanceKwh: Double?
    let energyDataThrough: Date?
}

struct LoadTiming: Decodable, Equatable {
    let hasTariff: Bool
    let hasCycleData: Bool
    let activeIsCheapest: Bool
    let periods: [LoadTimingPeriod]
    let pricingPeriods: [LoadTimingPeriod]
    let tariffTimeline: [LoadTimingTariffSegment]
    let nextCheaper: NextCheaperPeriod?
    let nextCheaperPhrase: String?
    let nextStartPhraseByKey: [String: String]

    private enum CodingKeys: String, CodingKey {
        case hasTariff, hasCycleData, activeIsCheapest, periods, pricingPeriods, tariffTimeline
        case nextCheaper, nextCheaperPhrase, nextStartPhraseByKey
    }

    init(
        hasTariff: Bool,
        hasCycleData: Bool,
        activeIsCheapest: Bool,
        periods: [LoadTimingPeriod],
        pricingPeriods: [LoadTimingPeriod],
        tariffTimeline: [LoadTimingTariffSegment] = [],
        nextCheaper: NextCheaperPeriod?,
        nextCheaperPhrase: String?,
        nextStartPhraseByKey: [String: String]
    ) {
        self.hasTariff = hasTariff
        self.hasCycleData = hasCycleData
        self.activeIsCheapest = activeIsCheapest
        self.periods = periods
        self.pricingPeriods = pricingPeriods
        self.tariffTimeline = tariffTimeline
        self.nextCheaper = nextCheaper
        self.nextCheaperPhrase = nextCheaperPhrase
        self.nextStartPhraseByKey = nextStartPhraseByKey
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hasTariff = try container.decode(Bool.self, forKey: .hasTariff)
        hasCycleData = try container.decode(Bool.self, forKey: .hasCycleData)
        activeIsCheapest = try container.decode(Bool.self, forKey: .activeIsCheapest)
        periods = try container.decode([LoadTimingPeriod].self, forKey: .periods)
        pricingPeriods = try container.decode([LoadTimingPeriod].self, forKey: .pricingPeriods)
        tariffTimeline = try container.decodeIfPresent([LoadTimingTariffSegment].self, forKey: .tariffTimeline) ?? []
        nextCheaper = try container.decodeIfPresent(NextCheaperPeriod.self, forKey: .nextCheaper)
        nextCheaperPhrase = try container.decodeIfPresent(String.self, forKey: .nextCheaperPhrase)
        nextStartPhraseByKey = try container.decode([String: String].self, forKey: .nextStartPhraseByKey)
    }
}

struct LoadTimingTariffSegment: Decodable, Equatable {
    let start: Date
    let end: Date
    let periodKey: String
    let name: String
    let buyRate: Double
    let sellRate: Double
}

struct LoadTimingPeriod: Decodable, Equatable {
    let name: String
    let marginalCost: Double?
    let basis: String
    let cycleNetExportKwh: Double
    let isActive: Bool
    let nextStartPhrase: String?
    let buyRate: Double
    let sellRate: Double
}

struct NextCheaperPeriod: Decodable, Equatable {
    let name: String
    let marginalCost: Double
    let phrase: String
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
