import Foundation

enum RatePlanTimelineFormatting {
    private static func utcCalendar() -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        return cal
    }

    static func parseYMD(_ ymd: String) -> Date? {
        let parts = ymd.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        let comps = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        return utcCalendar().date(from: comps)
    }

    static func parseYMD(_ ymd: String, in timeZone: TimeZone) -> Date? {
        let parts = ymd.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let comps = DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12)
        return cal.date(from: comps)
    }

    static func formatYMD(_ date: Date, in timeZone: TimeZone = TimeZone(secondsFromGMT: 0) ?? .gmt) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let comps = cal.dateComponents([.year, .month, .day], from: date)
        guard let year = comps.year, let month = comps.month, let day = comps.day else { return "" }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    static func displayDate(_ ymd: String) -> String {
        guard let date = parseYMD(ymd) else { return ymd }
        var style = Date.FormatStyle.dateTime.month(.abbreviated).day().year()
            .locale(Locale(identifier: "en_US_POSIX"))
        style.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
        return date.formatted(style)
    }

    static func displayRange(from startYMD: String, to endYMD: String?) -> String {
        let start = displayDate(startYMD)
        let end = endYMD.map(displayDate) ?? "Present"
        return "\(start) – \(end)"
    }

    static func gapDescription(newer: TariffPeriodDTO, older: TariffPeriodDTO) -> String? {
        guard let olderEndYMD = older.effectiveTo,
              let olderEnd = parseYMD(olderEndYMD),
              let newerStart = parseYMD(newer.effectiveFrom) else {
            return nil
        }
        let cal = utcCalendar()
        guard let gapStart = cal.date(byAdding: .day, value: 1, to: olderEnd),
              let gapEnd = cal.date(byAdding: .day, value: -1, to: newerStart),
              gapStart <= gapEnd else {
            return nil
        }
        let range = displayRange(from: formatYMD(gapStart), to: formatYMD(gapEnd))
        return "\(range) · Uses nearest prior plan"
    }

    static func seasonMonthLabel(fromMonth: Int, toMonth: Int) -> String {
        "\(monthAbbreviation(fromMonth)) – \(monthAbbreviation(toMonth))"
    }

    static func monthAbbreviation(_ month: Int) -> String {
        let names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        guard month >= 1, month <= 12 else { return "\(month)" }
        return names[month - 1]
    }

    static func fullMonthName(_ month: Int) -> String {
        let names = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ]
        guard month >= 1, month <= 12 else { return "\(month)" }
        return names[month - 1]
    }

    static func slotTimeLabel(_ slot: Int) -> String {
        let normalized = ((slot % 48) + 48) % 48
        let hour24 = normalized / 2
        let minute = (normalized % 2) * 30
        let suffix = hour24 >= 12 ? "PM" : "AM"
        let displayHour = hour24 % 12 == 0 ? 12 : hour24 % 12
        return String(format: "%d:%02d %@", displayHour, minute, suffix)
    }

    static func windowTimeLabel(_ window: TimePeriodWindowInput) -> String {
        let startSlot = window.fromHour * 2 + window.fromMinute / 30
        let endSlot = window.toHour == 24 ? 48 : window.toHour * 2 + window.toMinute / 30
        if startSlot == 0, endSlot == 48 || endSlot == 0 {
            return "All day"
        }
        return "\(slotTimeLabel(startSlot)) – \(slotTimeLabel(endSlot))"
    }
}
