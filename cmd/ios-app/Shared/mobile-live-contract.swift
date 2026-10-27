import Foundation

struct MobileLiveResponse: Codable, Equatable {
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
    let todayCost: TodayEnergyCost?
    let todayComplete: Bool
    let currentBill: Bill?
    let sources: Sources

    struct Site: Codable, Equatable {
        let id: String
        let name: String
        let timezone: String
        let localDate: String
    }

    struct Live: Codable, Equatable {
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

    struct Today: Codable, Equatable {
        let homeKwh: Double
        let solarKwh: Double
        let gridNetKwh: Double
        let batteryNetKwh: Double
    }

    struct Bill: Codable, Equatable {
        let estimatedCost: Double?
        let currency: String
        let cycleStart: Date
        let cycleEnd: Date
        let periods: [Period]

        var hasFiniteAmounts: Bool {
            (estimatedCost?.isFinite ?? true) && periods.allSatisfy(\.hasFiniteAmounts)
        }
    }

    struct Sources: Codable, Equatable {
        let liveStatusAt: Date?
        let energyDataThrough: Date?
        let stateOfChargeAt: Date?
    }

    enum ContractError: Error, Equatable {
        case unsupportedVersion(Int)
        case siteMismatch(expected: String, actual: String)
        case invalidAmount
    }

    private enum CodingKeys: String, CodingKey { case version, site, live, stateOfCharge, activeTariff, activeLoadTiming, today, todayCost, todayComplete, currentBill, sources }

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
        todayCost = try container.decodeIfPresent(TodayEnergyCost.self, forKey: .todayCost)
        todayComplete = try container.decode(Bool.self, forKey: .todayComplete)
        currentBill = try container.decodeIfPresent(Bill.self, forKey: .currentBill)
        self.sources = sources
    }

    /// Replace just the fast readings; history and bill source times stay unchanged.
    init(snapshot: MobileLiveResponse, power: MobileLivePowerResponse) {
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
        sources = Sources(liveStatusAt: power.sources.liveStatusAt,
                          energyDataThrough: snapshot.sources.energyDataThrough,
                          stateOfChargeAt: power.sources.stateOfChargeAt)
    }

    /// Money and rates are checked for finiteness only. JSON cannot carry NaN or infinity, so
    /// this guards against a non-conforming source rather than a wire value. Rates are not
    /// bounded below on purpose: the server prices negative buy and sell rates, and rejecting
    /// them would blank a real bill.
    func validating(siteID: String) throws -> Self {
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
    static func validatedStateOfCharge(_ reported: Double?, takenAt: Date?, now: Date) -> Double? {
        guard let reported, reported.isFinite, (0...100).contains(reported) else { return nil }
        guard let takenAt else { return nil }
        let age = now.timeIntervalSince(takenAt)
        guard age >= 0, age <= stateOfChargeMaximumAge else { return nil }
        return reported
    }
}

struct ActiveLoadTiming: Codable, Equatable {
    let periodName: String
    let buyRate: Double
    let sellRate: Double
    let marginalCost: Double?
    let basis: String
    let balanceKwh: Double?
    let energyDataThrough: Date?

    var hasFiniteAmounts: Bool {
        buyRate.isFinite && sellRate.isFinite && (marginalCost?.isFinite ?? true)
    }
}

struct Period: Codable, Equatable {
    let tariffName: String
    let periodName: String
    let netGridKwh: Double
    let cost: Double

    var hasFiniteAmounts: Bool { cost.isFinite }
}

/// Small foreground response independent of history and rate-plan summaries.
struct MobileLivePowerResponse: Codable, Equatable {
    let version: Int
    let siteID: String
    let live: MobileLiveResponse.Live
    let stateOfCharge: Double?
    let sources: Sources

    struct Sources: Codable, Equatable {
        let liveStatusAt: Date?
        let stateOfChargeAt: Date?
    }

    private enum CodingKeys: String, CodingKey { case version, siteID, live, stateOfCharge, sources }

    init(snapshot: MobileLiveResponse) {
        version = snapshot.version
        siteID = snapshot.site.id
        live = snapshot.live
        stateOfCharge = snapshot.stateOfCharge
        sources = Sources(
            liveStatusAt: snapshot.sources.liveStatusAt, stateOfChargeAt: snapshot.sources.stateOfChargeAt
        )
    }

    init(from decoder: Decoder) throws {
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

    func validating(siteID expected: String) throws -> Self {
        guard siteID == expected else {
            throw MobileLiveResponse.ContractError.siteMismatch(expected: expected, actual: siteID)
        }
        return self
    }
}
