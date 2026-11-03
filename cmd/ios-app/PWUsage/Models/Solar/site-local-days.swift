import Foundation

/// Calendar arithmetic on site-local `YYYY-MM-DD` days. Steps whole calendar days, so a 23- or
/// 25-hour daylight-saving day is still one day.
enum SiteLocalDays {
    static func today(now: Date, timeZone: TimeZone) -> String {
        format(now, calendar: calendar(timeZone))
    }

    /// `day` moved by `count` calendar days, or nil when `day` is not a real date.
    static func adding(_ count: Int, to day: String, timeZone: TimeZone) -> String? {
        let calendar = calendar(timeZone)
        guard let noon = noon(of: day, calendar: calendar),
              let moved = calendar.date(byAdding: .day, value: count, to: noon) else { return nil }
        return format(moved, calendar: calendar)
    }

    /// Calendar days from `start` to `end`; negative when `end` is earlier.
    static func days(from start: String, to end: String, timeZone: TimeZone) -> Int? {
        let calendar = calendar(timeZone)
        guard let from = noon(of: start, calendar: calendar), let until = noon(of: end, calendar: calendar) else {
            return nil
        }
        return calendar.dateComponents([.day], from: from, to: until).day
    }

    private static func calendar(_ timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    /// Noon exists on every day, unlike midnight where daylight saving starts at 00:00.
    private static func noon(of day: String, calendar: Calendar) -> Date? {
        let parts = day.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let dayOfMonth = Int(parts[2]) else { return nil }
        let components = DateComponents(year: year, month: month, day: dayOfMonth, hour: 12)
        guard components.isValidDate(in: calendar), let date = calendar.date(from: components) else { return nil }
        return date
    }

    private static func format(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }
}
