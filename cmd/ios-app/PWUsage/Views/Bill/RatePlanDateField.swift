import PWUsageCore
import SwiftUI

struct RatePlanDateField: View {
    let title: LocalizedStringKey
    @Binding var date: Date
    let boundary: RatePlanCalendarDays.MonthBoundary?
    var timeZone = Calendar.current.timeZone

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    var body: some View {
        DatePicker(title, selection: $date, displayedComponents: .date)
            .environment(\.calendar, calendar)
            .environment(\.timeZone, timeZone)
        if let boundary, let target = boundary.date(inMonthOf: date, timeZone: timeZone),
           !calendar.isDate(target, inSameDayAs: date) {
            Button(shortcutTitle(for: boundary, target: target)) { date = target }
        }
    }

    private func shortcutTitle(
        for boundary: RatePlanCalendarDays.MonthBoundary, target: Date
    ) -> LocalizedStringKey {
        let day = RatePlanTimelineFormatting.formatYMD(target, in: timeZone)
        let formatted = RatePlanTimelineFormatting.displayDate(day)
        switch boundary {
        case .first: return "Start on \(formatted)"
        case .last: return "End on \(formatted)"
        }
    }
}
