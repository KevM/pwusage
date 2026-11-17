import Foundation

extension DemoFixtures {
    static let demoUtilityName = "Demo Electric"

    /// Three past years of public rate plans: a Time of Use plan with two Peak windows
    /// (the second is the closest to the Tesla plan) and a fixed plan.
    static func rateHistory(asOf: Date) -> RatePlanHistoryDTO {
        let windows = [
            RatePlanPeakWindowDTO(label: "4-9 PM", fromHour: 16, toHour: 21),
            RatePlanPeakWindowDTO(label: "5-8 PM", fromHour: 17, toHour: 20)
        ]
        func plans(yearsAgo: Int) -> [RatePlanHistoryPlanDTO] {
            let start = isoDay(yearsAgo: yearsAgo, asOf: asOf)
            return [
                RatePlanHistoryPlanDTO(
                    name: "Residential Time of Use", startDate: start, kind: .timeOfUse, isDefault: false,
                    closest: true, lowRate: 0.11, highRate: 0.32, peakWindows: windows,
                    closestWindow: windows[1].label, fixedLabel: nil
                ),
                RatePlanHistoryPlanDTO(
                    name: "Residential Standard", startDate: start, kind: .fixed, isDefault: true,
                    closest: false, lowRate: 0.18, highRate: 0.18, peakWindows: [],
                    closestWindow: nil, fixedLabel: "demo-fixed-\(yearsAgo)"
                )
            ]
        }
        let calendar = demoCalendar
        let thisYear = calendar.component(.year, from: asOf)
        return RatePlanHistoryDTO(
            utilityName: demoUtilityName,
            historyStart: isoDay(yearsAgo: 3, asOf: asOf),
            fillThrough: nil,
            teslaShape: .timeOfUse,
            current: plans(yearsAgo: 0),
            years: (1 ... 3).map { offset in
                RatePlanHistoryYearDTO(
                    year: thisYear - offset,
                    askDate: isoDay(yearsAgo: offset, asOf: asOf),
                    plans: plans(yearsAgo: offset)
                )
            }
        )
    }

    static var demoCalendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    static func isoDay(yearsAgo: Int, asOf: Date) -> String {
        let calendar = demoCalendar
        let day = calendar.date(byAdding: .year, value: -yearsAgo, to: asOf) ?? asOf
        let parts = calendar.dateComponents([.year, .month, .day], from: day)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 1, parts.day ?? 1)
    }
}
