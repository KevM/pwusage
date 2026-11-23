import Foundation

public struct MobileSite: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let utility: String
    /// Day of the month the utility bill starts.
    public let billingDay: Int
    /// False while the day is still the server default and nobody has chosen it. A server that
    /// predates the field decodes as confirmed, so the app never asks for something it cannot save.
    public let billingDayConfirmed: Bool

    public init(id: String, name: String, utility: String, billingDay: Int = 1, billingDayConfirmed: Bool = true) {
        self.id = id
        self.name = name
        self.utility = utility
        self.billingDay = billingDay
        self.billingDayConfirmed = billingDayConfirmed
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        utility = try container.decode(String.self, forKey: .utility)
        billingDay = try container.decodeIfPresent(Int.self, forKey: .billingDay) ?? 1
        billingDayConfirmed = try container.decodeIfPresent(Bool.self, forKey: .billingDayConfirmed) ?? true
    }

    /// The same site once a person has chosen `day`.
    public func settingBillingDay(_ day: Int) -> MobileSite {
        MobileSite(id: id, name: name, utility: utility, billingDay: day, billingDayConfirmed: true)
    }
}

public struct MobileBillResponse: Codable, Equatable, Sendable {
    public let version: Int
    public let site: Site
    public let currentBill: Bill
    public let loadTiming: LoadTiming?
    public let tariffReattribution: ReattributionStatusDTO?
    public let sources: Sources
    public var outlook: BillOutlookHistory?
    public let revision: String?

    public struct Site: Codable, Equatable, Sendable {
        public let id: String
        public let name: String
        public let timezone: String

        public init(id: String, name: String, timezone: String) {
            self.id = id
            self.name = name
            self.timezone = timezone
        }
    }

    public struct Bill: Codable, Equatable, Sendable {
        public let estimatedCost: Double?
        public let currency: String
        public let cycleStart: Date
        public let cycleEnd: Date
        public let periods: [Period]

        public init(estimatedCost: Double?, currency: String, cycleStart: Date, cycleEnd: Date, periods: [Period]) {
            self.estimatedCost = estimatedCost
            self.currency = currency
            self.cycleStart = cycleStart
            self.cycleEnd = cycleEnd
            self.periods = periods
        }

        public var hasFiniteAmounts: Bool {
            (estimatedCost?.isFinite ?? true) && periods.allSatisfy(\.hasFiniteAmounts)
        }
    }

    public struct Sources: Codable, Equatable, Sendable {
        public let calculatedAt: Date
        public let energyDataThrough: Date?

        public init(calculatedAt: Date, energyDataThrough: Date?) {
            self.calculatedAt = calculatedAt
            self.energyDataThrough = energyDataThrough
        }
    }

    public enum ContractError: Error, Equatable, Sendable {
        case unsupportedVersion(Int)
        case siteMismatch(expected: String, actual: String)
        case invalidAmount
    }

    private enum CodingKeys: String, CodingKey {
        case version, site, currentBill, loadTiming, tariffReattribution, sources, outlook, revision
    }

    public init(
        version: Int,
        site: Site,
        currentBill: Bill,
        loadTiming: LoadTiming?,
        tariffReattribution: ReattributionStatusDTO?,
        sources: Sources,
        outlook: BillOutlookHistory? = nil,
        revision: String? = nil
    ) {
        self.version = version
        self.site = site
        self.currentBill = currentBill
        self.loadTiming = loadTiming
        self.tariffReattribution = tariffReattribution
        self.sources = sources
        self.outlook = outlook
        self.revision = revision
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let version = try container.decode(Int.self, forKey: .version)
        guard version == 1 else { throw ContractError.unsupportedVersion(version) }
        self.version = version
        site = try container.decode(Site.self, forKey: .site)
        currentBill = try container.decode(Bill.self, forKey: .currentBill)
        loadTiming = try container.decodeIfPresent(LoadTiming.self, forKey: .loadTiming)
        tariffReattribution = try container.decodeIfPresent(
            ReattributionStatusDTO.self,
            forKey: .tariffReattribution
        )
        sources = try container.decode(Sources.self, forKey: .sources)
        revision = try container.decodeIfPresent(String.self, forKey: .revision)
        // An optional outlook must never hide a usable recorded bill.
        outlook = try? container.decodeIfPresent(BillOutlookHistory.self, forKey: .outlook)
    }

    /// Finiteness only, as for `MobileLiveResponse.validating`: negative rates are real.
    public func validating(siteID: String) throws -> Self {
        guard site.id == siteID else {
            throw ContractError.siteMismatch(expected: siteID, actual: site.id)
        }
        guard currentBill.hasFiniteAmounts, loadTiming?.hasFiniteAmounts ?? true else {
            throw ContractError.invalidAmount
        }
        return self
    }
}

public struct MobileLoadPlanningContextResponse: Decodable, Equatable, Sendable {
    public static let maximumAge: TimeInterval = 24 * 60 * 60

    /// `asOf` is stamped by the *server* and compared against the *device* clock, so a
    /// device whose clock is *behind* the server sees it in the future even though the
    /// data is fine. A device running fast is the opposite: it makes `asOf` look older,
    /// which the positive bound below already accepted. This
    /// bound is deliberately asymmetric with the positive one: leniency here costs a
    /// bounded amount of mis-measured freshness, while strictness makes a mis-set
    /// device clock reject every response forever and blame the server for it.
    /// This is NOT the live contract's rule — `stateOfChargeMaximumAge` is about a
    /// suspect *reading* and requires `age >= 0`, which is stricter, not comparable.
    public static let maximumNegativeAgeSkew: TimeInterval = 60 * 60

    public let version: Int
    public let site: Site
    public let units: Units
    public let asOf: Date
    public let availability: Availability
    public let unavailableReason: String?
    public let usableDayCount: Int
    public let historyStart: Date
    public let historyEnd: Date
    public let slots: [Slot]

    public init(
        version: Int, site: Site, units: Units, asOf: Date, availability: Availability,
        unavailableReason: String?, usableDayCount: Int, historyStart: Date, historyEnd: Date, slots: [Slot]
    ) {
        self.version = version
        self.site = site
        self.units = units
        self.asOf = asOf
        self.availability = availability
        self.unavailableReason = unavailableReason
        self.usableDayCount = usableDayCount
        self.historyStart = historyStart
        self.historyEnd = historyEnd
        self.slots = slots
    }

    public struct Site: Decodable, Equatable, Sendable {
        public let id: String
        public let timezone: String

        public init(id: String, timezone: String) {
            self.id = id
            self.timezone = timezone
        }
    }

    public struct Units: Decodable, Equatable, Sendable {
        public let power: String
        public let localMinute: String

        public init(power: String, localMinute: String) {
            self.power = power
            self.localMinute = localMinute
        }
    }

    public enum Availability: String, Decodable, Equatable, Sendable {
        case available
        case unavailable
    }

    public struct Slot: Decodable, Equatable, Sendable {
        public let localMinute: Int
        public let homeKw: Double?
        public let batteryNetChargeKw: Double?
        public let sampleCount: Int
        public let coverage: Double
        /// Grid history over the last 28 days (export positive). Absent from
        /// older servers, which leaves the projection bounded by the forecast.
        public var gridNetExportKw: Double?
        /// The 1-in-4 "dull day" grid net export for the cautious projection.
        public var cautiousGridNetExportKw: Double?
        /// Median solar; not used by the projection yet.
        public var solarKw: Double?

        public init(
            localMinute: Int, homeKw: Double?, batteryNetChargeKw: Double?, sampleCount: Int, coverage: Double,
            gridNetExportKw: Double? = nil, cautiousGridNetExportKw: Double? = nil, solarKw: Double? = nil
        ) {
            self.localMinute = localMinute
            self.homeKw = homeKw
            self.batteryNetChargeKw = batteryNetChargeKw
            self.sampleCount = sampleCount
            self.coverage = coverage
            self.gridNetExportKw = gridNetExportKw
            self.cautiousGridNetExportKw = cautiousGridNetExportKw
            self.solarKw = solarKw
        }
    }

    public enum ContractError: Error, Equatable, Sendable {
        case unsupportedVersion(Int)
        case siteMismatch(expected: String, actual: String)
        /// `asOf` read against this device's clock falls outside the age window.
        /// Deliberately distinct from `invalidSource`: this is the one failure the
        /// person holding the phone can fix, so the UI may tell them to.
        case timestampSkew
        case invalidSource
    }

    public func validating(siteID: String, now: Date) throws -> Self {
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
                      && slot.coverage.isFinite && (0 ... 1).contains(slot.coverage)
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

    public var estimatorContext: LoadTimingForecastEstimator.PlanningContext? {
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
