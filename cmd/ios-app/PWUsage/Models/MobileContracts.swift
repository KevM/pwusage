import Foundation

struct MobileSite: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    let utility: String
}

struct MobileLiveResponse: Decodable, Equatable {
    /// A battery charge reading older than this is unknown, never "fresh". Mirrors the server
    /// rule in `buildMobileDashboardContract` — change one and you must change both: the server
    /// constant is `MOBILE_SOC_MAX_AGE_MS` in
    /// `cmd/next-app/src/lib/mobile-dashboard-contract.ts`, which uses the same inclusive `<=`
    /// edge. Without the client copy, a drifted, proxied, or cached response would present a
    /// stale percentage as current.
    static let stateOfChargeMaximumAge: TimeInterval = 2 * 3600

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

        private enum CodingKeys: String, CodingKey { case solarPower, loadPower, batteryPower, gridPower }

        /// Power readings are non-optional doubles, so a non-finite value has no "unknown" to map
        /// to without inventing one: `loadPower` drives the home total, so a null there would
        /// ripple. `0` is the honest floor — no generation, no draw — and both `batterySymbol` and
        /// the direction arrow already handle zero cleanly. This also means the map is
        /// defence-in-depth rather than wire-reachable validation: `JSONDecoder` rejects a number
        /// it cannot represent as a Swift `Double` (`1e400` and friends) and `NaN`/`Infinity` are
        /// not valid JSON, so nothing non-finite can arrive from a response. Negative readings are
        /// left alone, because negative grid and battery power are legitimate.
        static func finiteOrZero(_ value: Double) -> Double { value.isFinite ? value : 0 }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            solarPower = Self.finiteOrZero(try container.decode(Double.self, forKey: .solarPower))
            loadPower = Self.finiteOrZero(try container.decode(Double.self, forKey: .loadPower))
            batteryPower = Self.finiteOrZero(try container.decode(Double.self, forKey: .batteryPower))
            gridPower = Self.finiteOrZero(try container.decode(Double.self, forKey: .gridPower))
        }
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
        let sources = try container.decode(Sources.self, forKey: .sources)
        self.version = version
        site = try container.decode(Site.self, forKey: .site)
        live = try container.decode(Live.self, forKey: .live)
        let reportedCharge = try container.decodeIfPresent(Double.self, forKey: .stateOfCharge)
        stateOfCharge = Self.validatedStateOfCharge(
            reportedCharge,
            takenAt: sources.stateOfChargeAt,
            now: decoder.injectedCurrentDate ?? Date()
        )
        activeTariff = try container.decodeIfPresent(String.self, forKey: .activeTariff)
        activeLoadTiming = try container.decodeIfPresent(ActiveLoadTiming.self, forKey: .activeLoadTiming)
        today = try container.decode(Today.self, forKey: .today)
        todayComplete = try container.decode(Bool.self, forKey: .todayComplete)
        currentBill = try container.decodeIfPresent(Bill.self, forKey: .currentBill)
        self.sources = sources
    }

    /// A reading that cannot be dated, or that is out of range, is unknown rather than wrong.
    /// Suppressing towards `nil` is deliberate: a dropped timestamp must show `--`, not a
    /// reading we cannot vouch for.
    static func validatedStateOfCharge(_ reported: Double?, takenAt: Date?, now: Date) -> Double? {
        guard let reported, reported.isFinite, (0...100).contains(reported) else { return nil }
        guard let takenAt else { return nil }
        let age = now.timeIntervalSince(takenAt)
        guard age >= 0, age <= stateOfChargeMaximumAge else { return nil }
        return reported
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
              sourceAge >= -Self.maximumNegativeAgeSkew,
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
    /// The clock is resolved once, here, and handed to `init(from:)` through `userInfo`. That
    /// makes the freshness rules testable, but it also means a decoder is single-use: build one
    /// per response and never cache it in a `static let`, or every later decode silently judges
    /// freshness against the instant the cached decoder was built.
    static func make(now: @escaping @Sendable () -> Date = { Date() }) -> JSONDecoder {
        let decoder = JSONDecoder()
        if let key = CodingUserInfoKey.pwusageCurrentDate { decoder.userInfo[key] = now() }
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

extension CodingUserInfoKey {
    /// The clock the decoder was built with, so decode-time freshness rules stay testable.
    /// `CodingUserInfoKey.init(rawValue:)` is failable on this SDK, so the key stays optional
    /// and `MobileContractDecoder.make` simply skips the write if it cannot be formed.
    static let pwusageCurrentDate: CodingUserInfoKey? = CodingUserInfoKey(rawValue: "pwusage.currentDate")
}

extension Decoder {
    /// The clock `MobileContractDecoder.make` was built with, absent when the decoder carried none.
    var injectedCurrentDate: Date? {
        guard let key = CodingUserInfoKey.pwusageCurrentDate else { return nil }
        return userInfo[key] as? Date
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
