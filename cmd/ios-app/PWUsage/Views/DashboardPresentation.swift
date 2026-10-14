import Foundation

enum DashboardPresentation {
    enum PowerSource: String, CaseIterable, Identifiable {
        case solar, home, grid, battery
        var id: Self { self }
        var title: String { rawValue.capitalized }
    }

    enum PowerRole: Equatable {
        case supplying, receiving, idle, unknown
    }

    struct PowerCard: Equatable, Identifiable {
        let id: PowerSource
        let watts: Double?
        let role: PowerRole
        let detail: String
    }

    struct PowerFlow: Equatable {
        var supplying: [PowerCard]
        var receiving: [PowerCard]
    }

    static func livePowerUpdateDates(sourceTime: Date?, now: Date = .now) -> [Date] {
        var dates = [now]
        guard let sourceTime else { return dates }
        if sourceTime > now { dates.append(sourceTime) }
        // The freshness check includes exactly 15 minutes, so invalidate just beyond it.
        let expiry = sourceTime.addingTimeInterval(15 * 60 + 0.001)
        if expiry > now { dates.append(expiry) }
        return dates
    }

    static func powerFlow(solarPower: Double, loadPower: Double, batteryPower: Double, gridPower: Double,
                          sourceTime: Date?, isUnavailable: Bool,
                          now: Date = .now) -> PowerFlow {
        let isCurrent = !isUnavailable && sourceTime.map {
            let age = now.timeIntervalSince($0)
            return age >= 0 && age <= 15 * 60
        } == true
        let readings: [(PowerSource, Double)] = [
            (.solar, solarPower), (.home, loadPower),
            (.grid, gridPower), (.battery, batteryPower)
        ]
        let cards = readings.map { source, watts -> PowerCard in
            guard isCurrent, watts.isFinite else {
                return PowerCard(id: source, watts: watts.isFinite ? abs(watts) : nil,
                                 role: .unknown, detail: "Flow unknown")
            }
            let role: PowerRole
            let detail: String
            switch source {
            case .solar, .home:
                if watts < 0 {
                    role = .unknown
                    detail = "Flow unknown"
                } else if watts == 0 {
                    role = .idle
                    detail = "Idle"
                } else {
                    role = source == .solar ? .supplying : .receiving
                    detail = source == .solar ? "Producing" : "Using"
                }
            case .grid, .battery:
                if abs(watts) <= 50 {
                    role = .idle
                    detail = "Idle"
                } else {
                    role = watts > 0 ? .supplying : .receiving
                    detail = source == .grid
                        ? (watts > 0 ? "Importing" : "Exporting")
                        : (watts > 0 ? "Discharging" : "Charging")
                }
            }
            return PowerCard(id: source, watts: abs(watts), role: role, detail: detail)
        }
        var result = PowerFlow(supplying: cards.filter { $0.role == .supplying },
                               receiving: cards.filter { $0.role == .receiving })
        // Inactive cards occupy spare slots, but their placement never assigns a flow role.
        for card in cards where card.role == .idle || card.role == .unknown {
            if result.supplying.count <= result.receiving.count {
                result.supplying.append(card)
            } else {
                result.receiving.append(card)
            }
        }
        return result
    }

    struct LoadTimingSummary: Equatable {
        let title: String
        let rate: String?
        let balance: String?
        let message: String?
        let freshness: String?
        let accessibilityLabel: String
    }

    enum BatteryDirection: Equatable {
        case charging
        case discharging
        case idle
    }

    static func batteryDirection(powerWatts: Double) -> BatteryDirection {
        if powerWatts < -50 { return .charging }
        if powerWatts > 50 { return .discharging }
        return .idle
    }

    /// The charge bands and the charging bolt, kept here rather than on the view so
    /// the mapping is unit-testable. A `nil` charge is an unknown reading, not a
    /// full battery: it draws the blank outline, matching the TRMNL renderer, which
    /// renders an unfilled battery when `soc` is null. The charging bolt is omitted
    /// for the same reason — a bolt beside a blank battery asserts flow that the
    /// blank fill denies.
    static func batterySymbol(powerWatts: Double, stateOfCharge: Double?) -> String {
        guard let stateOfCharge else { return "battery.0percent" }
        let isCharging = batteryDirection(powerWatts: powerWatts) == .charging
        let level: String
        switch Int(stateOfCharge.rounded()) {
        case ..<13: level = "0percent"
        case 13..<38: level = "25percent"
        case 38..<63: level = "50percent"
        case 63..<88: level = "75percent"
        default: level = "100percent"
        }
        return isCharging ? "battery.\(level).bolt" : "battery.\(level)"
    }

    static func tariffPeriodTitle(_ name: String) -> String {
        guard !name.isEmpty,
              name.utf8.allSatisfy({ (65...90).contains($0) || $0 == 95 }) else {
            return name
        }
        return name.lowercased()
            .split(separator: "_", omittingEmptySubsequences: false)
            .map { String($0.prefix(1)).uppercased() + String($0.dropFirst()) }
            .joined(separator: "-")
    }

    static func batteryDescription(stateOfCharge: Double?, powerWatts: Double) -> String {
        let charge = stateOfCharge.map { "\(Int($0.rounded()))%" } ?? "--"
        let direction: String
        switch batteryDirection(powerWatts: powerWatts) {
        case .charging: direction = "Charging"
        case .discharging: direction = "Discharging"
        case .idle: direction = "Idle"
        }
        return "Battery \(charge), \(direction)"
    }

    static func power(_ watts: Double) -> String {
        let magnitude = abs(watts)
        if magnitude >= 1_000 {
            return String(format: "%.1f kW", watts / 1_000)
        }
        return "\(Int(watts.rounded())) W"
    }

    static func batteryPower(_ watts: Double) -> String {
        abs(watts) < 10 ? "Idle" : power(watts)
    }

    static func batteryPowerDetail(_ watts: Double) -> String? {
        if abs(watts) < 10 { return nil }
        return watts < 0 ? "Charging" : "Discharging"
    }

    static func energy(_ kWh: Double) -> String {
        TodayEnergyPresentation.energy(kWh)
    }

    static func signedGridEnergy(_ kWh: Double) -> String {
        TodayEnergyPresentation.signedEnergy(kWh)
    }

    static func tariffBalance(_ netGridKwh: Double) -> String {
        let status = netGridKwh < 0 ? "Surplus" : (netGridKwh > 0 ? "Deficit" : "Balanced")
        return "\(status) \(energy(abs(netGridKwh)))"
    }

    static func signedBatteryEnergy(_ kWh: Double) -> String {
        TodayEnergyPresentation.signedEnergy(kWh)
    }

    static func currency(_ amount: Double?, code: String, locale: Locale = .current) -> String {
        guard let amount else { return "Unavailable" }
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = code
        formatter.locale = locale
        return formatter.string(from: NSNumber(value: amount)) ?? "\(amount) \(code)"
    }

    static func loadRate(_ amountPerKwh: Double?, code: String, locale: Locale = .current) -> String {
        guard let amountPerKwh else { return "Unavailable" }
        if code == "USD" {
            return "\(loadRateInCents(amountPerKwh, locale: locale))"
        }
        return "\(currency(amountPerKwh, code: code, locale: locale))/kWh"
    }

    static func loadBalance(_ balanceKwh: Double?) -> String {
        guard let balanceKwh else { return "No balance yet" }
        let status = balanceKwh < 0 ? "Surplus" : (balanceKwh > 0 ? "Deficit" : "Balanced")
        return "\(status) \(loadEnergyNumber(abs(balanceKwh))) kWh"
    }

    static func liveLoadBalance(_ cycleNetExportKwh: Double?) -> String {
        guard let cycleNetExportKwh else { return "No balance yet" }
        let status = cycleNetExportKwh > 0 ? "Surplus" : (cycleNetExportKwh < 0 ? "Deficit" : "Balanced")
        return "\(status) \(loadEnergyNumber(abs(cycleNetExportKwh))) kWh"
    }

    static func loadBalanceAccessibilityLabel(_ balanceKwh: Double?) -> String {
        guard let balanceKwh else { return "No balance yet" }
        let status = balanceKwh < 0 ? "Surplus" : (balanceKwh > 0 ? "Deficit" : "Balanced")
        return "\(status) \(loadEnergyNumber(abs(balanceKwh))) kilowatt-hours"
    }

    static func liveLoadBalanceAccessibilityLabel(_ cycleNetExportKwh: Double?) -> String {
        guard let cycleNetExportKwh else { return "No balance yet" }
        let status = cycleNetExportKwh > 0 ? "Surplus" : (cycleNetExportKwh < 0 ? "Deficit" : "Balanced")
        return "\(status) \(loadEnergyNumber(abs(cycleNetExportKwh))) kilowatt-hours"
    }

    static func loadRateAccessibilityLabel(_ amountPerKwh: Double?, code: String, locale: Locale = .current) -> String {
        guard let amountPerKwh else { return "Cost per kilowatt-hour unavailable" }
        if code == "USD" {
            let cents = loadRateInCents(amountPerKwh, locale: locale)
                .replacingOccurrences(of: "¢/kWh", with: "")
            return "\(cents) \(cents == "1" ? "cent" : "cents") per kilowatt-hour"
        }
        return "\(currency(amountPerKwh, code: code, locale: locale)) per kilowatt-hour"
    }

    static func loadTimingSummary(
        _ timing: ActiveLoadTiming?,
        hasTariff: Bool,
        isStale: Bool,
        currencyCode: String? = nil
    ) -> LoadTimingSummary {
        guard hasTariff else {
            return LoadTimingSummary(title: "Load timing unavailable", rate: nil, balance: nil, message: "No active tariff is configured", freshness: nil, accessibilityLabel: "Load timing unavailable. No active tariff is configured")
        }
        guard let timing else {
            return LoadTimingSummary(title: "Load timing unavailable", rate: nil, balance: nil, message: "Load timing is unavailable", freshness: nil, accessibilityLabel: "Load timing unavailable")
        }

        let title = tariffPeriodTitle(timing.periodName)
        let isUnobserved = timing.basis == "unobserved"
        let rateValue = isUnobserved ? timing.buyRate : timing.marginalCost
        let rate = currencyCode.map { loadRate(rateValue, code: $0) }
        let balance = isUnobserved ? "No balance yet" : (timing.balanceKwh.map(liveLoadBalance) ?? "Balance unavailable")
        let freshness = isStale ? "Showing the last successful live summary" : nil
        let spokenRate = currencyCode.map { loadRateAccessibilityLabel(rateValue, code: $0) }
        let label = [title, spokenRate, isUnobserved ? "No balance yet" : liveLoadBalanceAccessibilityLabel(timing.balanceKwh), freshness]
            .compactMap { $0 }
            .joined(separator: ", ")
        return LoadTimingSummary(title: title, rate: rate, balance: balance, message: nil, freshness: freshness, accessibilityLabel: label)
    }

    /// Whether the Load timing card must say it is showing a stale summary.
    ///
    /// A negative age counts as stale, and it has to: the summary's own heading is
    /// built by `freshness(_:staleAfter:)`, which renders "Source time is in the
    /// future" for exactly this case. An upper bound alone reported the summary as
    /// current while the heading two lines above said the opposite — the same
    /// self-contradiction §5.7 fixed for the forecast overlay and §8.18 for the
    /// battery glyph. `liveFreshnessNotice` already treats a negative age the same
    /// way, so this keeps the two on one rule.
    ///
    /// A `nil` source is not stale: there is nothing dated to be out of date, and
    /// the heading is already saying the source time is unavailable.
    static func loadTimingSummaryIsStale(source: Date?, now: Date = .now, staleAfter: TimeInterval = 30 * 60) -> Bool {
        guard let source else { return false }
        let age = now.timeIntervalSince(source)
        return age < 0 || age > staleAfter
    }

    static func hasActiveTariff(label: String?) -> Bool {
        guard let label else { return false }
        let normalized = label.trimmingCharacters(in: .whitespacesAndNewlines)
        return !normalized.isEmpty && normalized.caseInsensitiveCompare("Unknown") != .orderedSame
    }

    static func loadRateInCents(_ amountPerKwh: Double?, locale: Locale = .current) -> String {
        guard let amountPerKwh else { return "Cost unavailable/kWh" }
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        let cents = amountPerKwh * 100
        let roundedCents = cents.rounded()
        formatter.minimumFractionDigits = abs(cents - roundedCents) < 0.00000001 ? 0 : 1
        formatter.maximumFractionDigits = 2
        formatter.locale = locale
        return "\(formatter.string(from: NSNumber(value: cents)) ?? String(format: "%.1f", cents))¢/kWh"
    }

    private static func loadEnergyNumber(_ kWh: Double) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 1
        formatter.maximumFractionDigits = 1
        formatter.roundingMode = .halfUp
        return formatter.string(from: NSNumber(value: kWh)) ?? String(format: "%.1f", kWh)
    }

    static func freshness(_ date: Date?, now: Date = .now, staleAfter: TimeInterval = 15 * 60) -> String {
        guard let date else { return "Source time unavailable" }
        let age = now.timeIntervalSince(date)
        guard age >= 0 else { return "Source time is in the future" }
        let minutes = Int(age / 60)
        let ageText: String
        if minutes < 1 { ageText = "updated just now" }
        else if minutes < 60 { ageText = "updated \(minutes) min ago" }
        else {
            let hours = minutes / 60
            ageText = hours < 24 ? "updated \(hours) hr ago" : "updated \(hours / 24) days ago"
        }
        return age > staleAfter ? "Stale · \(ageText)" : "Updated \(ageText.replacingOccurrences(of: "updated ", with: ""))"
    }

    static func liveFreshnessNotice(_ date: Date?, now: Date = .now) -> String? {
        guard let date else { return "Source time unavailable" }
        let age = now.timeIntervalSince(date)
        guard age < 0 || age > 15 * 60 else { return nil }
        return freshness(date, now: now)
    }

    static func chargeAgeLabel(_ date: Date?, now: Date = .now) -> String? {
        guard let date else { return nil }
        let age = now.timeIntervalSince(date)
        guard age > 20 * 60 else { return nil }
        let minutes = Int(age / 60)
        return minutes < 60 ? "Charge as of \(minutes) min ago" : "Charge as of \(minutes / 60) hr ago"
    }

    static func date(_ date: Date, timeZoneIdentifier: String, dateStyle: DateFormatter.Style = .medium, timeStyle: DateFormatter.Style = .none) -> String {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.timeZone = TimeZone(identifier: timeZoneIdentifier) ?? .current
        formatter.dateStyle = dateStyle
        formatter.timeStyle = timeStyle
        return formatter.string(from: date)
    }
}
