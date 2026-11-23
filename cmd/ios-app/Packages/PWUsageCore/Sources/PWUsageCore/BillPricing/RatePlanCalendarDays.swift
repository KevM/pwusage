import Foundation

/// Converts tariff timeline day keys using a Gregorian calendar in the site's time zone.
public enum RatePlanCalendarDays {
    public enum MonthBoundary {
        case first
        case last

        public func date(inMonthOf date: Date, timeZone: TimeZone) -> Date? {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            guard let month = calendar.dateInterval(of: .month, for: date) else { return nil }
            switch self {
            case .first:
                return month.start
            case .last:
                return calendar.date(byAdding: .day, value: -1, to: month.end)
            }
        }
    }

    public static func parseYMD(_ ymd: String, in timeZone: TimeZone) -> Date? {
        let parts = ymd.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let comps = DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12)
        return cal.date(from: comps)
    }

    public static func formatYMD(_ date: Date, in timeZone: TimeZone = TimeZone(secondsFromGMT: 0) ?? .gmt) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let comps = cal.dateComponents([.year, .month, .day], from: date)
        guard let year = comps.year, let month = comps.month, let day = comps.day else { return "" }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }
}
