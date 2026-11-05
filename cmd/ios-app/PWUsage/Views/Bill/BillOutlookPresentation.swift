import Foundation

enum BillOutlookPresentation {
    /// A saving this close to the bill is worth a row above the charts; earlier, the charts can still change.
    private static let savingsWindowDays = 7

    static func selection(in points: [BillOutlookPoint], date: Date?) -> BillOutlookPoint? {
        guard let date else { return points.last }
        return points.min { abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date)) }
    }
    static func balance(_ netGridKwh: Double) -> String {
        if abs(netGridKwh) < 0.05 { return "Even" }
        let label = netGridKwh < 0 ? "Export cushion" : "Import gap"
        return "\(label) · \(DashboardPresentation.energy(abs(netGridKwh)))"
    }

    static func daysLeft(now: Date, end: Date, timeZone: String) -> Int? {
        guard end > now, let zone = TimeZone(identifier: timeZone) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        return calendar.dateComponents([.day], from: calendar.startOfDay(for: now),
                                       to: calendar.startOfDay(for: end)).day
    }
    static func daysLeftLabel(_ days: Int) -> String {
        if days == 0 { return "Ends today" }
        return "\(days) \(days == 1 ? "day" : "days") left"
    }
    static func projectionLabel(projectedEnd: Date, cycleEnd: Date, timeZone: String,
                                locale: Locale = .current) -> String {
        guard projectedEnd != cycleEnd else { return "By cycle end" }
        var style = Date.FormatStyle(locale: locale).month(.abbreviated).day()
        style.timeZone = TimeZone(identifier: timeZone) ?? .current
        return "By \(projectedEnd.formatted(style))"
    }
    static func projectedAmount(_ cost: Double, currency: String, locale: Locale = .current) -> String {
        "about \(cost.formatted(.currency(code: currency).locale(locale).precision(.fractionLength(0))))"
    }
    /// How far the bar fills, or nil when a credit or a falling bill means a bar would mislead.
    static func fillFraction(soFar: Double, projected: Double) -> Double? {
        guard projected > 0, soFar >= 0, soFar <= projected else { return nil }
        return soFar / projected
    }
    static func projectionBasis(usesSolar: Bool, usesHistory: Bool) -> String {
        guard usesSolar else { return "Based on your recent grid history." }
        return usesHistory
            ? "Based on the solar forecast and typical home use, with recent grid history where the forecast ends."
            : "Based on the solar forecast and typical home use."
    }
    /// Lane header: the bill's total so far, or the selected day's running balance while exploring.
    static func laneSummary(period: BillOutlookPeriod, totals: [Period], selected: BillOutlookPeriod?) -> String? {
        if let selected { return balance(selected.netGridKwh) }
        return totals.first {
            $0.tariffName == period.tariffName && $0.periodName == period.periodName
        }.map { balance($0.netGridKwh) }
    }
    /// The saving still possible by the bill date, once the projection reaches it and the bill is close.
    static func savingsMove(projected: [BillOutlookPoint], remaining: [BillOutlookTariff], cycleEnd: Date,
                            daysLeft: Int?) -> BillSavingsMove? {
        guard let daysLeft, daysLeft <= savingsWindowDays, let end = projected.last, end.date == cycleEnd,
              let shift = BillOutlook.bestShift(projected: end, remaining: remaining) else { return nil }
        return BillSavingsMove.make(from: shift)
    }
}
