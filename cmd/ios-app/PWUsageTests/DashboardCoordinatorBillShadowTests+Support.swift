import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

extension DashboardCoordinatorBillShadowTests {
    func timelineWithIncrementedBuyRate(
        _ timeline: SiteTariffsTimelineResponse,
        delta: Double
    ) -> SiteTariffsTimelineResponse {
        let updatedPeriods = timeline.periods.map { period in
            let updatedSeasons = period.seasons.map { season in
                let increment: (TimePeriodWindowInput) -> TimePeriodWindowInput = { window in
                    TimePeriodWindowInput(
                        touName: window.touName,
                        fromHour: window.fromHour,
                        fromMinute: window.fromMinute,
                        toHour: window.toHour,
                        toMinute: window.toMinute,
                        buyRate: window.buyRate + delta,
                        sellRate: window.sellRate
                    )
                }
                return TariffSeasonInput(
                    name: season.name,
                    fromMonth: season.fromMonth,
                    toMonth: season.toMonth,
                    weekdayPeriods: season.weekdayPeriods.map(increment),
                    weekendPeriods: season.weekendPeriods.map(increment),
                    fromDay: season.fromDay,
                    toDay: season.toDay
                )
            }
            return TariffPeriodDTO(
                periodId: period.periodId,
                tariffId: period.tariffId,
                name: period.name,
                version: period.version,
                source: period.source,
                effectiveFrom: period.effectiveFrom,
                effectiveTo: period.effectiveTo,
                isCurrentToday: period.isCurrentToday,
                updatedBy: period.updatedBy,
                seasons: updatedSeasons
            )
        }
        return SiteTariffsTimelineResponse(
            version: timeline.version,
            siteId: timeline.siteId,
            timezone: timeline.timezone,
            currency: timeline.currency,
            periods: updatedPeriods,
            reattribution: timeline.reattribution,
            holidayDates: timeline.holidayDates,
            teslaSync: timeline.teslaSync
        )
    }
}

@MainActor
final class BillShadowAPISpy:
    MobileDashboardDataAPI,
    MobileTariffDataAPI,
    MobileBillShadowAPI,
    MobileSolarHistoryDataAPI {
    let bill: MobileBillResponse
    let timeline: SiteTariffsTimelineResponse
    var shadowReports: [BillShadowReport] = []
    var timelineFetchCount = 0
    var billFetchCount = 0
    var solarHistoryFetchCount = 0
    var timelineFetchResult: TimelineFetch = .unchanged

    init(bill: MobileBillResponse, timeline: SiteTariffsTimelineResponse) {
        self.bill = bill
        self.timeline = timeline
    }

    func fetchLive(siteID: String, refresh: Bool) async throws -> MobileLiveResponse {
        throw PWUsageAPIError.invalidResponse
    }

    func fetchBill(siteID: String) async throws -> MobileBillResponse {
        billFetchCount += 1
        return bill
    }

    func fetchTariffTimeline(siteID: String) async throws -> SiteTariffsTimelineResponse {
        timelineFetchCount += 1
        return timeline
    }

    func fetchTariffTimeline(siteID: String, knownETag: String?) async throws -> TimelineFetch {
        timelineFetchCount += 1
        return timelineFetchResult
    }

    func fetchSolarHistory(
        siteID: String,
        from: String,
        changedSince: Date?
    ) async throws -> MobileSolarHistoryResponse {
        solarHistoryFetchCount += 1
        let timeZone = TimeZone(identifier: timeline.timezone) ?? .gmt
        return .enabled(timeZone: timeZone, days: [], nextFrom: nil)
    }

    func refreshTariffsFromTesla(siteID: String) async throws -> SiteTariffsTimelineResponse {
        timeline
    }

    func createTariffPeriod(siteID: String, body: TariffPlanWriteRequest) async throws -> SiteTariffsTimelineResponse {
        timeline
    }

    func updateTariffPeriod(
        siteID: String, periodID: Int, body: TariffPlanPatchRequest
    ) async throws -> SiteTariffsTimelineResponse {
        timeline
    }

    func deleteTariffPeriod(siteID: String, periodID: Int) async throws -> SiteTariffsTimelineResponse {
        timeline
    }

    func retryTariffReattribution(siteID: String) async throws -> SiteTariffsTimelineResponse {
        timeline
    }

    func reportBillShadow(_ report: BillShadowReport) async throws {
        shadowReports.append(report)
    }
}
