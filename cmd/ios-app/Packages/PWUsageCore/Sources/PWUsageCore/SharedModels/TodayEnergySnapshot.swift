import Foundation

/// Presentation-only daily totals. No authentication or battery control state belongs here.
public struct TodayEnergy: Codable, Equatable, Sendable {
    public var localDate: String
    public var homeKwh: Double
    public var solarKwh: Double
    public var gridNetKwh: Double
    public var batteryNetKwh: Double
    public var activeTariff: String?
    public var todayComplete = true
    public var energyDataThrough: Date?

    public init(
        localDate: String, homeKwh: Double, solarKwh: Double, gridNetKwh: Double, batteryNetKwh: Double,
        activeTariff: String? = nil, todayComplete: Bool = true, energyDataThrough: Date? = nil
    ) {
        self.localDate = localDate
        self.homeKwh = homeKwh
        self.solarKwh = solarKwh
        self.gridNetKwh = gridNetKwh
        self.batteryNetKwh = batteryNetKwh
        self.activeTariff = activeTariff
        self.todayComplete = todayComplete
        self.energyDataThrough = energyDataThrough
    }
}

public struct TodayEnergySnapshot: Codable, Equatable, Sendable {
    public static let widgetKind = "TodayEnergy"
    public static let metricWidgetKind = "TodayEnergyMetric"
    public static let staleAfter: TimeInterval = 30 * 60
    public var version = 2
    public let siteID: String
    public let siteName: String
    public let timezone: String
    public let fetchedAt: Date
    public var energy: TodayEnergy
    public var todayCost: TodayEnergyCost?
    public var batteryStateOfCharge: Double?
    public var batteryStateOfChargeAt: Date?

    public init(
        version: Int = 2, siteID: String, siteName: String, timezone: String, fetchedAt: Date, energy: TodayEnergy,
        todayCost: TodayEnergyCost? = nil, batteryStateOfCharge: Double? = nil, batteryStateOfChargeAt: Date? = nil
    ) {
        self.version = version
        self.siteID = siteID
        self.siteName = siteName
        self.timezone = timezone
        self.fetchedAt = fetchedAt
        self.energy = energy
        self.todayCost = todayCost
        self.batteryStateOfCharge = batteryStateOfCharge
        self.batteryStateOfChargeAt = batteryStateOfChargeAt
    }

    /// SOC freshness is independent of the daily energy source. Match the app's two-hour rule.
    public func stateOfCharge(at date: Date) -> Double? {
        guard let charge = batteryStateOfCharge, charge.isFinite, (0 ... 100).contains(charge),
              let source = batteryStateOfChargeAt else { return nil }
        let age = date.timeIntervalSince(source)
        return age >= 0 && age <= 2 * 3600 ? charge : nil
    }

    public enum Availability: Sendable { case current, stale, missing }

    public static func localDate(_ date: Date, timezone: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: timezone)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    public func availability(at date: Date) -> Availability {
        guard version == 2, TimeZone(identifier: timezone) != nil,
              energy.localDate == Self.localDate(date, timezone: timezone),
              let source = energy.energyDataThrough, source <= date, fetchedAt <= date,
              Self.localDate(source, timezone: timezone) == energy.localDate,
              [energy.homeKwh, energy.solarKwh].allSatisfy({ $0.isFinite && $0 >= 0 }),
              [energy.gridNetKwh, energy.batteryNetKwh].allSatisfy(\.isFinite) else { return .missing }
        return date.timeIntervalSince(source) > Self.staleAfter ? .stale : .current
    }

    /// Shared scheduling for both widget kinds. All dates come from the same cached sources.
    public static func timelineDates(for snapshot: Self?, at now: Date) -> [Date] {
        var dates = [now]
        if let source = snapshot?.energy.energyDataThrough {
            let expiry = source.addingTimeInterval(staleAfter + 1)
            if expiry > now { dates.append(expiry) }
        }
        if let source = snapshot?.batteryStateOfChargeAt {
            let expiry = source.addingTimeInterval(2 * 3600 + 1)
            if expiry > now { dates.append(expiry) }
        }
        if let midnight = snapshot?.nextMidnight, midnight > now { dates.append(midnight) }
        return Array(Set(dates)).sorted()
    }

    public static func sample(at now: Date) -> Self {
        Self(siteID: "preview", siteName: "Home", timezone: "UTC", fetchedAt: now,
             energy: TodayEnergy(localDate: localDate(now, timezone: "UTC"), homeKwh: 18.4,
                                 solarKwh: 22.6, gridNetKwh: -4.2, batteryNetKwh: -1.8,
                                 activeTariff: "Off peak", energyDataThrough: now),
             batteryStateOfCharge: 78, batteryStateOfChargeAt: now)
    }

    public var nextMidnight: Date? {
        guard let zone = TimeZone(identifier: timezone) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.dateInterval(of: .day, for: fetchedAt)?.end
    }
}
