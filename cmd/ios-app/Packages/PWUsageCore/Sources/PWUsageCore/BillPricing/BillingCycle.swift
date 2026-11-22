import Foundation

public enum BillingCycle {
    /// Returns the `[start, end)` UTC instants of the site-local billing cycle containing `now`.
    /// Clamps `billingDay` to each month's length (e.g. 31 -> Feb 28/29) and re-anchors on the next month.
    public static func current(billingDay: Int, now: Date, timeZone: TimeZone) -> (start: Date, end: Date) {
        let anchorDay = (1 ... 31).contains(billingDay) ? billingDay : 1
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone

        let comps = calendar.dateComponents([.year, .month, .day], from: now)
        let daysInMonth = calendar.range(of: .day, in: .month, for: now)?.count ?? 28
        let clampedDay = min(anchorDay, daysInMonth)

        var cycleYear = comps.year ?? 1970
        var cycleMonth = comps.month ?? 1
        if (comps.day ?? 1) < clampedDay {
            cycleMonth -= 1
            if cycleMonth < 1 {
                cycleMonth = 12
                cycleYear -= 1
            }
        }

        let start = siteLocalMidnight(
            year: cycleYear,
            month: cycleMonth,
            anchorDay: anchorDay,
            calendar: calendar
        )
        var nextYear = cycleYear
        var nextMonth = cycleMonth + 1
        if nextMonth > 12 {
            nextMonth = 1
            nextYear += 1
        }
        let end = siteLocalMidnight(
            year: nextYear,
            month: nextMonth,
            anchorDay: anchorDay,
            calendar: calendar
        )
        return (start: start, end: end)
    }

    public static func cycles(
        billingDay: Int,
        from startDate: Date,
        through endDate: Date,
        timeZone: TimeZone
    ) -> [(start: Date, end: Date)] {
        let effectiveStart = min(startDate, endDate)
        let first = current(billingDay: billingDay, now: effectiveStart, timeZone: timeZone)
        let last = current(billingDay: billingDay, now: endDate, timeZone: timeZone)
        guard first.start < last.end else { return [last] }

        var result: [(start: Date, end: Date)] = []
        var cursor = first
        while cursor.start <= last.start {
            result.append(cursor)
            if cursor.start == last.start { break }
            cursor = current(billingDay: billingDay, now: cursor.end, timeZone: timeZone)
        }
        return result
    }

    private static func siteLocalMidnight(
        year: Int,
        month: Int,
        anchorDay: Int,
        calendar: Calendar
    ) -> Date {
        guard let firstOfMonth = calendar.date(from: DateComponents(year: year, month: month, day: 1)) else {
            return Date(timeIntervalSince1970: 0)
        }
        let daysInMonth = calendar.range(of: .day, in: .month, for: firstOfMonth)?.count ?? 28
        let clampedDay = min(anchorDay, daysInMonth)
        guard let target = calendar.date(from: DateComponents(year: year, month: month, day: clampedDay)) else {
            return firstOfMonth
        }
        return calendar.startOfDay(for: target)
    }
}
