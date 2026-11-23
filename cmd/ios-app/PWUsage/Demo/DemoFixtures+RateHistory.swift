import Foundation
import PWUsageCore

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

    /// A flat all-day plan, the shape every fixed comparison plan has.
    static func flatSeasons(buy: Double, sell: Double) -> [TariffSeasonInput] {
        let window = demoWindow(.offPeak, startHour: 0, endHour: 24, buy: buy, sell: sell)
        return [TariffSeasonInput(
            name: "All Year", fromMonth: 1, toMonth: 12, weekdayPeriods: [window], weekendPeriods: [window],
            fromDay: 1, toDay: 31
        )]
    }

    /// The utility's plans in effect on `effectiveDate`, which Change on a comparison row offers.
    static func publicPlans(effectiveDate: String) -> PublicUtilityPlansResponse {
        let peak = demoWindow(.onPeak, startHour: 16, endHour: 21, buy: 0.32, sell: 0.04)
        let offPeak = demoWindow(.offPeak, startHour: 21, endHour: 16, buy: 0.11, sell: 0.03)
        let timeOfUse = TariffSeasonInput(
            name: "All Year", fromMonth: 1, toMonth: 12, weekdayPeriods: [peak, offPeak],
            weekendPeriods: [demoWindow(.offPeak, startHour: 0, endHour: 24, buy: 0.11, sell: 0.03)]
        )
        return PublicUtilityPlansResponse(
            utilityName: demoUtilityName,
            effectiveDate: effectiveDate,
            currency: "USD",
            plans: [
                UtilityPlanDTO(
                    label: "demo-fixed", name: "Residential Standard", startDate: effectiveDate,
                    utilityName: demoUtilityName, kind: .fixed, isDefault: true, currency: "USD",
                    seasons: flatSeasons(buy: 0.18, sell: 0)
                ),
                UtilityPlanDTO(
                    label: "demo-fixed-low-income", name: "Residential Care", startDate: effectiveDate,
                    utilityName: demoUtilityName, kind: .fixed, isDefault: false, currency: "USD",
                    seasons: flatSeasons(buy: 0.14, sell: 0)
                ),
                UtilityPlanDTO(
                    label: "demo-tou", name: "Residential Time of Use", startDate: effectiveDate,
                    utilityName: demoUtilityName, kind: .timeOfUse, isDefault: false, currency: "USD",
                    seasons: [timeOfUse]
                )
            ]
        )
    }

    /// Fixed comparison periods that cross a rate plan boundary: the first covers the end of the
    /// earlier rate plan and the start of the current one, and a mid-plan revision starts the second,
    /// so the current plan shows two comparison rows.
    static func demoReferencePeriods() -> [TariffPeriodDTO] {
        func period(id: Int, from: String, to: String?, buy: Double) -> TariffPeriodDTO {
            TariffPeriodDTO(
                periodId: id, tariffId: id * 10, name: "Residential Standard", version: 1, source: .estimated,
                effectiveFrom: from, effectiveTo: to, isCurrentToday: to == nil, updatedBy: nil,
                seasons: flatSeasons(buy: buy, sell: 0), startSource: .urdb
            )
        }
        return [
            period(id: 11, from: "2025-01-01", to: "2026-03-31", buy: 0.17),
            period(id: 12, from: "2026-04-01", to: nil, buy: 0.18)
        ]
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
