import Foundation

struct MobileSite: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    let utility: String
}

struct MobileBillResponse: Codable, Equatable {
    let version: Int
    let site: Site
    let currentBill: Bill
    let loadTiming: LoadTiming?
    let sources: Sources

    struct Site: Codable, Equatable {
        let id: String
        let name: String
        let timezone: String
    }

    struct Bill: Codable, Equatable {
        let estimatedCost: Double?
        let currency: String
        let cycleStart: Date
        let cycleEnd: Date
        let periods: [Period]
    }

    struct Sources: Codable, Equatable {
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

    /// `asOf` is stamped by the *server* and compared against the *device* clock, so a
    /// device whose clock is *behind* the server sees it in the future even though the
    /// data is fine. A device running fast is the opposite: it makes `asOf` look older,
    /// which the positive bound below already accepted. This
    /// bound is deliberately asymmetric with the positive one: leniency here costs a
    /// bounded amount of mis-measured freshness, while strictness makes a mis-set
    /// device clock reject every response forever and blame the server for it.
    /// This is NOT the live contract's rule — `stateOfChargeMaximumAge` is about a
    /// suspect *reading* and requires `age >= 0`, which is stricter, not comparable.
    static let maximumNegativeAgeSkew: TimeInterval = 60 * 60

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
        /// Grid history over the last 28 days (export positive). Absent from
        /// older servers, which leaves the projection bounded by the forecast.
        var gridNetExportKw: Double? = nil
        /// The 1-in-4 "dull day" grid net export for the cautious projection.
        var cautiousGridNetExportKw: Double? = nil
        /// Median solar; not used by the projection yet.
        var solarKw: Double? = nil
    }

    enum ContractError: Error, Equatable {
        case unsupportedVersion(Int)
        case siteMismatch(expected: String, actual: String)
        /// `asOf` read against this device's clock falls outside the age window.
        /// Deliberately distinct from `invalidSource`: this is the one failure the
        /// person holding the phone can fix, so the UI may tell them to.
        case timestampSkew
        case invalidSource
    }

    func validating(siteID: String, now: Date) throws -> Self {
        let sourceAge = now.timeIntervalSince(asOf)
        guard version == 1 else { throw ContractError.unsupportedVersion(version) }
        guard site.id == siteID else { throw ContractError.siteMismatch(expected: siteID, actual: site.id) }
        // Checked apart from the structural checks below: a skewed clock and a
        // malformed payload both land here, but only one is fixable on the device,
        // so they must not share an error the UI turns into advice.
        guard sourceAge >= -Self.maximumNegativeAgeSkew,
              sourceAge <= Self.maximumAge else { throw ContractError.timestampSkew }
        guard units.power == "kW", units.localMinute == "minute-of-day",
              TimeZone(identifier: site.timezone) != nil,
              asOf.timeIntervalSince1970.isFinite,
              historyStart.timeIntervalSince1970.isFinite,
              historyEnd.timeIntervalSince1970.isFinite,
              historyStart < historyEnd,
              historyEnd <= asOf,
              slots.count == 48,
              slots.enumerated().allSatisfy({ index, slot in
                  slot.localMinute == index * 30
                      && slot.sampleCount >= 0
                      && slot.coverage.isFinite && (0...1).contains(slot.coverage)
                      && slot.homeKw.map(\.isFinite) ?? true
                      && slot.batteryNetChargeKw.map(\.isFinite) ?? true
                      && slot.gridNetExportKw.map(\.isFinite) ?? true
                      && slot.cautiousGridNetExportKw.map(\.isFinite) ?? true
                      && slot.solarKw.map(\.isFinite) ?? true
              }),
              // `coverage` is the share of usable days that voted for the slot. The
              // 90% interval rule is applied server-side before a day/slot may vote,
              // so requiring 0.9 here rejected real sites whose late-evening slots
              // had 10 of 13 votes, and with them the whole profile.
              availability != .available || (
                  usableDayCount >= 5
                      && slots.allSatisfy { slot in
                          guard slot.homeKw != nil || slot.batteryNetChargeKw != nil else { return true }
                          return slot.sampleCount >= 5
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
                    batteryNetChargeKw: $0.batteryNetChargeKw,
                    gridNetExportKw: $0.gridNetExportKw,
                    cautiousGridNetExportKw: $0.cautiousGridNetExportKw
                )
            },
            asOf: asOf
        )
    }
}

struct LoadTiming: Codable, Equatable {
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
        nextStartPhraseByKey = try container.decodeIfPresent([String: String].self, forKey: .nextStartPhraseByKey) ?? [:]
    }
}

struct LoadTimingTariffSegment: Codable, Equatable {
    let start: Date
    let end: Date
    let periodKey: String
    let name: String
    let buyRate: Double
    let sellRate: Double
}

struct LoadTimingPeriod: Codable, Equatable {
    let name: String
    let marginalCost: Double?
    let basis: String
    let cycleNetExportKwh: Double
    let isActive: Bool
    let nextStartPhrase: String?
    let buyRate: Double
    let sellRate: Double
}

struct NextCheaperPeriod: Codable, Equatable {
    let name: String
    let marginalCost: Double
    let phrase: String
}
