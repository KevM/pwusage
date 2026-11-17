import Foundation
@testable import PWUsage
import Testing

enum SavingsTestFixtures {
    static func makeDay(
        _ dayString: String,
        solar: [Float?],
        load: [Float?],
        grid: [Float?],
        battery: [Float?]? = nil
    ) throws -> EnergyFlowDay {
        let parts = dayString.split(separator: "-").compactMap { Int($0) }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = try #require(TimeZone(identifier: "UTC"))
        let start = try #require(cal.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])))
        return EnergyFlowDay(
            day: dayString,
            dayStart: start,
            solarWh: solar,
            loadWh: load,
            gridWh: grid,
            batteryWh: battery ?? Array(repeating: Float?(0), count: grid.count),
            batterySoc: Array(repeating: nil, count: grid.count)
        )
    }

    static func makeUTCDate(year: Int, month: Int, day: Int, hour: Int) throws -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = try #require(TimeZone(identifier: "UTC"))
        return try #require(cal.date(from: DateComponents(year: year, month: month, day: day, hour: hour)))
    }

    static func makeTimeline(
        actualBuy: Double,
        actualSell: Double,
        refBuy: Double,
        refSell: Double,
        actualEffectiveFrom: String = "2020-01-01",
        refEffectiveFrom: String = "2020-01-01"
    ) -> SiteTariffsTimelineResponse {
        let actualPeriod = makeFlatPeriod(
            id: 1,
            name: "Actual",
            buyRate: actualBuy,
            sellRate: actualSell,
            effectiveFrom: actualEffectiveFrom
        )
        let refPeriod = makeFlatPeriod(
            id: 2,
            name: "Reference",
            buyRate: refBuy,
            sellRate: refSell,
            effectiveFrom: refEffectiveFrom
        )
        return makeTimeline(actual: [actualPeriod], reference: [refPeriod])
    }

    static func makeTimeline(
        actual: [TariffPeriodDTO], reference: [TariffPeriodDTO], timezone: String = "UTC"
    ) -> SiteTariffsTimelineResponse {
        SiteTariffsTimelineResponse(
            version: 2,
            siteId: "site-1",
            timezone: timezone,
            currency: "USD",
            periods: actual,
            referencePeriods: reference,
            battery: nil,
            reattribution: nil,
            holidayDates: [],
            teslaSync: TeslaSyncDTO(
                latestTariffId: nil,
                latestTariffName: nil,
                latestUpdatedAt: nil,
                activeManualUpdatedAt: nil,
                differsFromActiveManual: false
            )
        )
    }

    static func withReference(
        timeline: SiteTariffsTimelineResponse,
        buyRate: Double,
        sellRate: Double
    ) -> SiteTariffsTimelineResponse {
        let refPeriod = makeFlatPeriod(id: 99, name: "Reference", buyRate: buyRate, sellRate: sellRate)
        return SiteTariffsTimelineResponse(
            version: timeline.version,
            siteId: timeline.siteId,
            timezone: timeline.timezone,
            currency: timeline.currency,
            periods: timeline.periods,
            referencePeriods: [refPeriod],
            battery: timeline.battery,
            reattribution: timeline.reattribution,
            holidayDates: timeline.holidayDates,
            teslaSync: timeline.teslaSync
        )
    }

    static func makeFlatPeriod(
        id: Int,
        name: String,
        buyRate: Double,
        sellRate: Double,
        effectiveFrom: String = "2020-01-01",
        effectiveTo: String? = nil,
        source: TariffSource = .manual
    ) -> TariffPeriodDTO {
        let window = TimePeriodWindowInput(
            touName: .offPeak,
            fromHour: 0,
            fromMinute: 0,
            toHour: 24,
            toMinute: 0,
            buyRate: buyRate,
            sellRate: sellRate
        )
        let season = TariffSeasonInput(
            name: "All Year",
            fromMonth: 1,
            toMonth: 12,
            weekdayPeriods: [window],
            weekendPeriods: [window]
        )
        return TariffPeriodDTO(
            periodId: id,
            tariffId: id * 10,
            name: name,
            version: 1,
            source: source,
            effectiveFrom: effectiveFrom,
            effectiveTo: effectiveTo,
            isCurrentToday: true,
            updatedBy: nil,
            seasons: [season]
        )
    }
}
