import Foundation

/// Presentation-only daily totals. No authentication or battery control state belongs here.
struct TodayEnergy: Codable, Equatable, Sendable {
    var localDate: String
    var homeKwh: Double
    var solarKwh: Double
    var gridNetKwh: Double
    var batteryNetKwh: Double
    var activeTariff: String? = nil
    var todayComplete = true
    var energyDataThrough: Date?
}

struct TodayEnergySnapshot: Codable, Equatable, Sendable {
    static let widgetKind = "TodayEnergy"
    static let metricWidgetKind = "TodayEnergyMetric"
    static let staleAfter: TimeInterval = 30 * 60
    var version = 2
    let siteID: String
    let siteName: String
    let timezone: String
    let fetchedAt: Date
    var energy: TodayEnergy
    var batteryStateOfCharge: Double? = nil
    var batteryStateOfChargeAt: Date? = nil

    /// SOC freshness is independent of the daily energy source. Match the app's two-hour rule.
    func stateOfCharge(at date: Date) -> Double? {
        guard let charge = batteryStateOfCharge, charge.isFinite, (0...100).contains(charge),
              let source = batteryStateOfChargeAt else { return nil }
        let age = date.timeIntervalSince(source)
        return age >= 0 && age <= 2 * 3600 ? charge : nil
    }


    enum Availability { case current, stale, missing }

    static func localDate(_ date: Date, timezone: String) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: timezone)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    func availability(at date: Date) -> Availability {
        guard version == 2, TimeZone(identifier: timezone) != nil,
              energy.localDate == Self.localDate(date, timezone: timezone),
              let source = energy.energyDataThrough, source <= date, fetchedAt <= date,
              Self.localDate(source, timezone: timezone) == energy.localDate,
              [energy.homeKwh, energy.solarKwh].allSatisfy({ $0.isFinite && $0 >= 0 }),
              [energy.gridNetKwh, energy.batteryNetKwh].allSatisfy(\.isFinite) else { return .missing }
        return date.timeIntervalSince(source) > Self.staleAfter ? .stale : .current
    }

    /// Shared scheduling for both widget kinds. All dates come from the same cached sources.
    static func timelineDates(for snapshot: Self?, at now: Date) -> [Date] {
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

    static func sample(at now: Date) -> Self {
        Self(siteID: "preview", siteName: "Home", timezone: "UTC", fetchedAt: now,
             energy: TodayEnergy(localDate: localDate(now, timezone: "UTC"), homeKwh: 18.4,
                                 solarKwh: 22.6, gridNetKwh: -4.2, batteryNetKwh: -1.8,
                                 activeTariff: "Off peak", energyDataThrough: now),
             batteryStateOfCharge: 78, batteryStateOfChargeAt: now)
    }

    var nextMidnight: Date? {
        guard let zone = TimeZone(identifier: timezone) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.dateInterval(of: .day, for: fetchedAt)?.end
    }
}

/// Single app writer, atomic replacement, read-only widget. Missing entitlement fails closed.
struct TodayEnergySnapshotStore {
    let fileURL: URL

    static func shared() -> Self? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "PWUSAGE_APP_GROUP") as? String,
              let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
        return Self(fileURL: directory.appendingPathComponent("today-energy-v2.json"))
    }

    func load() -> TodayEnergySnapshot? {
        guard let data = try? Data(contentsOf: fileURL),
              let value = try? JSONDecoder().decode(TodayEnergySnapshot.self, from: data),
              value.version == 2 else { return nil }
        return value
    }

    func save(_ value: TodayEnergySnapshot) throws {
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(value).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func clear() {
        // Write a tombstone atomically before removal, so a failed removal cannot expose old data.
        try? Data("{}".utf8).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try? FileManager.default.removeItem(at: fileURL)
    }
}
