import Foundation

enum BillOutlookPresentation {
    static func selection(in points: [BillOutlookPoint], date: Date?) -> BillOutlookPoint? {
        guard let date else { return points.last }
        return points.min { abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date)) }
    }
    static func balance(_ netGridKwh: Double) -> String {
        if abs(netGridKwh) < 0.05 { return "Even" }
        let label = netGridKwh < 0 ? "Export cushion" : "Import gap"
        return "\(label) · \(DashboardPresentation.energy(abs(netGridKwh)))"
    }

    static func deadline(now: Date, end: Date, timeZone: String) -> String? {
        guard end > now, let zone = TimeZone(identifier: timeZone) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now),
                                           to: calendar.startOfDay(for: end)).day ?? 0
        guard days <= 7 else { return nil }
        if days == 0 { return "Cycle ends today" }
        return "Cycle ends in \(days) \(days == 1 ? "day" : "days")"
    }
    static func projection(cost: Double, currency: String, projectedEnd: Date, timeZone: String,
                           locale: Locale = .current) -> String {
        "About \(DashboardPresentation.currency(cost, code: currency, locale: locale)) by "
            + DashboardPresentation.date(projectedEnd, timeZoneIdentifier: timeZone, dateStyle: .short)
    }
    /// Lane header: the bill's total so far, or the selected day's running balance while exploring.
    static func laneSummary(period: BillOutlookPeriod, totals: [Period], selected: BillOutlookPeriod?,
                            currency: String, locale: Locale = .current) -> String? {
        if let selected { return balance(selected.netGridKwh) }
        guard let total = totals.first(where: { $0.tariffName == period.tariffName && $0.periodName == period.periodName })
        else { return nil }
        return balance(total.netGridKwh) + " · " + DashboardPresentation.currency(total.cost, code: currency, locale: locale)
    }
    static func guidance(observed: BillOutlookPoint?, projected: BillOutlookPoint?) -> String? {
        guard let observed, let projected else { return nil }
        if let closing = observed.periods.first(where: { period in
            period.netGridKwh > 0.1 && projected.periods.contains { $0.key == period.key && $0.netGridKwh <= 0 }
        }) {
            return "Expected exports may close your \(DashboardPresentation.tariffPeriodTitle(closing.periodName)) import gap."
        }
        if let gap = projected.periods.filter({ $0.netGridKwh > 0.1 }).max(by: { $0.netGridKwh < $1.netGridKwh }) {
            return "An import gap is expected in \(DashboardPresentation.tariffPeriodTitle(gap.periodName)). Smart Shift can help time your heavy energy use."
        }
        return "An export cushion is expected to remain. Check Smart Shift before starting heavy energy use."
    }
}
