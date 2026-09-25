import Foundation

enum DashboardPresentation {
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
        String(format: "%.1f kWh", kWh)
    }

    static func signedGridEnergy(_ kWh: Double) -> String {
        let direction = kWh > 0 ? "↓ " : (kWh < 0 ? "↑ " : "")
        return direction + energy(abs(kWh))
    }

    static func tariffBalance(_ netGridKwh: Double) -> String {
        let status = netGridKwh < 0 ? "Surplus" : (netGridKwh > 0 ? "Deficit" : "Balanced")
        return "\(status) \(energy(abs(netGridKwh)))"
    }

    static func signedBatteryEnergy(_ kWh: Double) -> String {
        let direction = kWh > 0 ? "↓ " : (kWh < 0 ? "↑ " : "")
        return direction + energy(abs(kWh))
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
