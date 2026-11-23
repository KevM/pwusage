import Foundation

public struct MobileLiveResponse: Codable, Equatable, Sendable {
    /// A battery charge reading older than this is unknown, never "fresh". Mirrors the server
    /// rule in `buildMobileDashboardContract` — change one and you must change both: the server
    /// constant is `MOBILE_SOC_MAX_AGE_MS` in
    /// `cmd/next-app/src/lib/mobile-dashboard-contract.ts`, which uses the same inclusive `<=`
    /// edge. Without the client copy, a drifted, proxied, or cached response would present a
    /// stale percentage as current.
    public static let stateOfChargeMaximumAge: TimeInterval = 2 * 3600

    public let version: Int
    public let site: Site
    public let live: Live
    public let stateOfCharge: Double?
    public let activeTariff: String?
    public let activeLoadTiming: ActiveLoadTiming?
    public let today: Today
    public let todayCost: TodayEnergyCost?
    public let todayComplete: Bool
    public let currentBill: Bill?
    public let sources: Sources
    public let historyRevision: String?
    public var historyRefresh: HistoryRefresh?

    public struct HistoryRefresh: Codable, Equatable, Sendable {
        public let status: HistoryRefreshStatus

        public init(status: HistoryRefreshStatus) {
            self.status = status
        }
    }

    public enum HistoryRefreshStatus: String, Codable, Sendable {
        case changed, current, overdue, pending, failed, throttled
        case awaitingData = "awaiting-data"
    }

    public struct Site: Codable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let timezone: String
        public let localDate: String
    }

    public struct Live: Codable, Equatable, Sendable {
        public let solarPower: Double
        public let loadPower: Double
        public let batteryPower: Double
        public let gridPower: Double

        /// Power readings are non-optional doubles, so a non-finite value has no "unknown" to map
        /// to without inventing one: `loadPower` drives the home total, so a null there would
        /// ripple. `0` is the honest floor — no generation, no draw — and both `batterySymbol` and
        /// the direction arrow already handle zero cleanly. This also means the map is
        /// defence-in-depth rather than wire-reachable validation: `JSONDecoder` rejects a number
        /// it cannot represent as a Swift `Double` (`1e400` and friends) and `NaN`/`Infinity` are
        /// not valid JSON, so nothing non-finite can arrive from a response. Negative readings are
        /// left alone, because negative grid and battery power are legitimate.
        public static func finiteOrZero(_ value: Double) -> Double { value.isFinite ? value : 0 }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: LiveCodingKeys.self)
            solarPower = Self.finiteOrZero(try container.decode(Double.self, forKey: .solarPower))
            loadPower = Self.finiteOrZero(try container.decode(Double.self, forKey: .loadPower))
            batteryPower = Self.finiteOrZero(try container.decode(Double.self, forKey: .batteryPower))
            gridPower = Self.finiteOrZero(try container.decode(Double.self, forKey: .gridPower))
        }

        /// Encoding uses the same keys as decoding, so the two cannot drift apart.
        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: LiveCodingKeys.self)
            try container.encode(solarPower, forKey: .solarPower)
            try container.encode(loadPower, forKey: .loadPower)
            try container.encode(batteryPower, forKey: .batteryPower)
            try container.encode(gridPower, forKey: .gridPower)
        }
    }

    public struct Today: Codable, Equatable, Sendable {
        public let homeKwh: Double
        public let solarKwh: Double
        public let gridNetKwh: Double
        public let batteryNetKwh: Double
    }

    public struct Bill: Codable, Equatable, Sendable {
        public let estimatedCost: Double?
        public let currency: String
        public let cycleStart: Date
        public let cycleEnd: Date
        public let periods: [Period]

        public var hasFiniteAmounts: Bool {
            (estimatedCost?.isFinite ?? true) && periods.allSatisfy(\.hasFiniteAmounts)
        }
    }

    public struct Sources: Codable, Equatable, Sendable {
        public let liveStatusAt: Date?
        public let energyDataThrough: Date?
        public let stateOfChargeAt: Date?
    }

    public enum ContractError: Error, Equatable, Sendable {
        case unsupportedVersion(Int)
        case siteMismatch(expected: String, actual: String)
        case invalidAmount
    }

    private enum CodingKeys: String, CodingKey {
        case version, site, live, stateOfCharge, activeTariff, activeLoadTiming,
             today, todayCost, todayComplete, currentBill, sources, historyRevision, historyRefresh
    }

    public init(from decoder: Decoder) throws {
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
        todayCost = try container.decodeIfPresent(TodayEnergyCost.self, forKey: .todayCost)
        todayComplete = try container.decode(Bool.self, forKey: .todayComplete)
        currentBill = try container.decodeIfPresent(Bill.self, forKey: .currentBill)
        self.sources = sources
        historyRevision = try container.decodeIfPresent(String.self, forKey: .historyRevision)
        // A newer server may add outcomes. An unknown outcome still carries usable readings.
        historyRefresh = try? container.decodeIfPresent(HistoryRefresh.self, forKey: .historyRefresh)
    }

    /// Replace just the fast readings; history and bill source times stay unchanged.
    public init(snapshot: MobileLiveResponse, power: MobileLivePowerResponse) {
        version = snapshot.version
        site = snapshot.site
        live = power.live
        stateOfCharge = power.stateOfCharge
        activeTariff = snapshot.activeTariff
        activeLoadTiming = snapshot.activeLoadTiming
        today = snapshot.today
        todayCost = snapshot.todayCost
        todayComplete = snapshot.todayComplete
        currentBill = snapshot.currentBill
        historyRevision = snapshot.historyRevision
        historyRefresh = snapshot.historyRefresh
        sources = Sources(liveStatusAt: power.sources.liveStatusAt,
                          energyDataThrough: snapshot.sources.energyDataThrough,
                          stateOfChargeAt: power.sources.stateOfChargeAt)
    }

    /// Money and rates are checked for finiteness only. JSON cannot carry NaN or infinity, so
    /// this guards against a non-conforming source rather than a wire value. Rates are not
    /// bounded below on purpose: the server prices negative buy and sell rates, and rejecting
    /// them would blank a real bill.
    public func validating(siteID: String) throws -> Self {
        guard site.id == siteID else {
            throw ContractError.siteMismatch(expected: siteID, actual: site.id)
        }
        guard currentBill?.hasFiniteAmounts ?? true,
              activeLoadTiming?.hasFiniteAmounts ?? true else { throw ContractError.invalidAmount }
        return self
    }

    /// A reading that cannot be dated, or that is out of range, is unknown rather than wrong.
    /// Suppressing towards `nil` is deliberate: a dropped timestamp must show `--`, not a
    /// reading we cannot vouch for.
    public static func validatedStateOfCharge(_ reported: Double?, takenAt: Date?, now: Date) -> Double? {
        guard let reported, reported.isFinite, (0 ... 100).contains(reported) else { return nil }
        guard let takenAt else { return nil }
        let age = now.timeIntervalSince(takenAt)
        guard age >= 0, age <= stateOfChargeMaximumAge else { return nil }
        return reported
    }
}

/// Lifted out of `MobileLiveResponse.Live` so the coding keys stay one type level deep.
private enum LiveCodingKeys: String, CodingKey {
    case solarPower, loadPower, batteryPower, gridPower
}

public struct ActiveLoadTiming: Codable, Equatable, Sendable {
    public let periodName: String
    public let buyRate: Double
    public let sellRate: Double
    public let marginalCost: Double?
    public let basis: String
    public let balanceKwh: Double?
    public let energyDataThrough: Date?

    public init(
        periodName: String, buyRate: Double, sellRate: Double, marginalCost: Double?, basis: String,
        balanceKwh: Double?, energyDataThrough: Date?
    ) {
        self.periodName = periodName
        self.buyRate = buyRate
        self.sellRate = sellRate
        self.marginalCost = marginalCost
        self.basis = basis
        self.balanceKwh = balanceKwh
        self.energyDataThrough = energyDataThrough
    }

    public var hasFiniteAmounts: Bool {
        buyRate.isFinite && sellRate.isFinite && (marginalCost?.isFinite ?? true)
    }
}

public struct Period: Codable, Equatable, Sendable {
    public let tariffName: String
    public let periodName: String
    public let netGridKwh: Double
    public let cost: Double

    public init(tariffName: String, periodName: String, netGridKwh: Double, cost: Double) {
        self.tariffName = tariffName
        self.periodName = periodName
        self.netGridKwh = netGridKwh
        self.cost = cost
    }

    public var hasFiniteAmounts: Bool { cost.isFinite }
}

/// Small foreground response independent of history and rate-plan summaries.
public struct MobileLivePowerResponse: Codable, Equatable, Sendable {
    public let version: Int
    public let siteID: String
    public let live: MobileLiveResponse.Live
    public let stateOfCharge: Double?
    public let sources: Sources

    public struct Sources: Codable, Equatable, Sendable {
        public let liveStatusAt: Date?
        public let stateOfChargeAt: Date?
    }

    private enum CodingKeys: String, CodingKey { case version, siteID, live, stateOfCharge, sources }

    public init(snapshot: MobileLiveResponse) {
        version = snapshot.version
        siteID = snapshot.site.id
        live = snapshot.live
        stateOfCharge = snapshot.stateOfCharge
        sources = Sources(
            liveStatusAt: snapshot.sources.liveStatusAt, stateOfChargeAt: snapshot.sources.stateOfChargeAt
        )
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        guard version == 1 else { throw MobileLiveResponse.ContractError.unsupportedVersion(version) }
        siteID = try container.decode(String.self, forKey: .siteID)
        live = try container.decode(MobileLiveResponse.Live.self, forKey: .live)
        sources = try container.decode(Sources.self, forKey: .sources)
        stateOfCharge = MobileLiveResponse.validatedStateOfCharge(
            try container.decodeIfPresent(Double.self, forKey: .stateOfCharge),
            takenAt: sources.stateOfChargeAt, now: decoder.injectedCurrentDate ?? Date()
        )
    }

    public func validating(siteID expected: String) throws -> Self {
        guard siteID == expected else {
            throw MobileLiveResponse.ContractError.siteMismatch(expected: expected, actual: siteID)
        }
        return self
    }
}
