import Foundation
import PWUsageCore

enum NotReadyReason: Equatable, Sendable {
    case flowsMissing
    case noTimeline
}

enum LocalBillResult: Equatable, Sendable {
    case ready(MobileBillResponse)
    case notReady(NotReadyReason)
}

/// Assembles a `MobileBillResponse` on device from stored energy flows and the cached rate plan timeline.
struct LocalBillBuilder {
    let store: SolarHistoryStore

    init(store: SolarHistoryStore = .shared) {
        self.store = store
    }

    func build(
        site: MobileBillResponse.Site,
        billingDay: Int,
        timeline: SiteTariffsTimelineResponse?,
        scope: SolarForecastSiteScope,
        now: Date
    ) async throws -> LocalBillResult {
        guard let timeline,
              let siteZone = TimeZone(identifier: site.timezone),
              let resolver = RatePeriodResolver(timeline: timeline) else {
            return .notReady(.noTimeline)
        }

        let cycle = BillingCycle.current(billingDay: billingDay, now: now, timeZone: siteZone)
        guard let flowDays = try await store.flowDays(scope: scope, from: cycle.start, to: cycle.end),
              !flowDays.isEmpty else {
            return .notReady(.flowsMissing)
        }

        let assembly = LocalBillAssembly.compute(
            days: flowDays,
            cycle: cycle,
            resolver: resolver,
            now: now,
            timeZone: siteZone
        )
        let periods = assembly.periods.map { period in
            Period(
                tariffName: period.tariffName,
                periodName: period.periodName,
                netGridKwh: period.netGridKwh,
                cost: period.cost
            )
        }
        let currency = timeline.currency.isEmpty ? "USD" : timeline.currency
        let bill = MobileBillResponse.Bill(
            estimatedCost: assembly.estimatedCost,
            currency: currency,
            cycleStart: cycle.start,
            cycleEnd: cycle.end,
            periods: periods
        )
        return .ready(MobileBillResponse(
            version: 1,
            site: site,
            currentBill: bill,
            loadTiming: assembly.loadTiming,
            tariffReattribution: timeline.reattribution,
            sources: MobileBillResponse.Sources(calculatedAt: now, energyDataThrough: assembly.energyDataThrough),
            outlook: assembly.outlook,
            revision: nil
        ))
    }
}
