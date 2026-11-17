import CryptoKit
import Foundation

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
    private static let slotSeconds: TimeInterval = 300
    private static let timelineLookbackSeconds: TimeInterval = 60 * 60
    private static let loadTimingHorizonSeconds: TimeInterval = 7 * 24 * 60 * 60

    private struct BillSummary {
        let estimatedCost: Double?
        let periods: [Period]
    }

    private struct LoadTimingInput {
        let buckets: [BillUsageBucket]
        let costs: [Double]
        let resolver: RatePeriodResolver
        let cycleEnd: Date
        let energyDataThrough: Date?
        let now: Date
        let timeZone: TimeZone
    }

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

        let buckets = BillUsageAggregator.buckets(days: flowDays, from: cycle.start, to: cycle.end, resolver: resolver)
        let costs = BillPricing.costs(buckets)
        let summary = Self.summarizeBill(buckets: buckets, costs: costs)
        let energyDataThrough = Self.lastNonNilSlotInstant(in: flowDays, cycleStart: cycle.start, cycleEnd: cycle.end)
        let loadTiming = Self.buildLoadTiming(LoadTimingInput(
            buckets: buckets,
            costs: costs,
            resolver: resolver,
            cycleEnd: cycle.end,
            energyDataThrough: energyDataThrough,
            now: now,
            timeZone: siteZone
        ))
        let outlook = BillOutlookHistoryBuilder.build(.init(
            days: flowDays,
            cycleStart: cycle.start,
            cycleEnd: cycle.end,
            now: now,
            resolver: resolver,
            timeZone: siteZone
        ))

        let currency = timeline.currency.isEmpty ? "USD" : timeline.currency
        let bill = MobileBillResponse.Bill(
            estimatedCost: summary.estimatedCost,
            currency: currency,
            cycleStart: cycle.start,
            cycleEnd: cycle.end,
            periods: summary.periods
        )
        return .ready(MobileBillResponse(
            version: 1,
            site: site,
            currentBill: bill,
            loadTiming: loadTiming,
            tariffReattribution: timeline.reattribution,
            sources: MobileBillResponse.Sources(calculatedAt: now, energyDataThrough: energyDataThrough),
            outlook: outlook,
            revision: nil
        ))
    }

    static func timelineFingerprint(_ timeline: SiteTariffsTimelineResponse) -> String {
        struct FingerprintPayload: Encodable {
            let periods: [TariffPeriodDTO]
            let referencePeriods: [TariffPeriodDTO]
            let battery: SiteBatteryDTO?
            let holidayDates: [String]
            let systemCosts: SystemCostsDTO?
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let payload = FingerprintPayload(
            periods: timeline.periods,
            referencePeriods: timeline.referencePeriods,
            battery: timeline.battery,
            holidayDates: timeline.holidayDates ?? [],
            systemCosts: timeline.systemCosts
        )
        let data = (try? encoder.encode(payload)) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func summarizeBill(buckets: [BillUsageBucket], costs: [Double]) -> BillSummary {
        guard !buckets.isEmpty else {
            return BillSummary(estimatedCost: nil, periods: [])
        }
        struct PeriodGroupKey: Hashable {
            let tariffName: String
            let periodName: String
        }
        var periods: [Period] = []
        var indexByKey: [PeriodGroupKey: Int] = [:]
        var totalCost = 0.0

        for (bucket, cost) in zip(buckets, costs) {
            let tariffName = bucket.planName.isEmpty ? "Unknown" : bucket.planName
            let periodName = bucket.periodName.isEmpty ? "Unknown" : bucket.periodName
            let key = PeriodGroupKey(tariffName: tariffName, periodName: periodName)
            let kwh = bucket.gridWh / 1000.0
            totalCost += cost

            if let existingIndex = indexByKey[key] {
                let existing = periods[existingIndex]
                periods[existingIndex] = Period(
                    tariffName: tariffName,
                    periodName: periodName,
                    netGridKwh: existing.netGridKwh + kwh,
                    cost: existing.cost + cost
                )
            } else {
                indexByKey[key] = periods.count
                periods.append(Period(
                    tariffName: tariffName,
                    periodName: periodName,
                    netGridKwh: kwh,
                    cost: cost
                ))
            }
        }
        return BillSummary(estimatedCost: totalCost, periods: periods)
    }

    private static func buildLoadTiming(_ input: LoadTimingInput) -> LoadTiming? {
        guard let computed = LoadTimingCalculator.compute(
            buckets: input.buckets,
            costs: input.costs,
            resolver: input.resolver,
            now: input.now,
            timeZone: input.timeZone
        ) else {
            return nil
        }

        let clampedEnergyThrough = input.energyDataThrough.map { min($0, input.now) } ?? input.now
        let timelineStart = max(clampedEnergyThrough, input.now.addingTimeInterval(-timelineLookbackSeconds))
        let sevenDaysOut = input.now.addingTimeInterval(loadTimingHorizonSeconds)
        let segments = LoadTimingTimelineBuilder.segments(
            resolver: input.resolver,
            from: timelineStart,
            to: max(sevenDaysOut, input.cycleEnd),
            requiredEnd: sevenDaysOut
        )
        return LoadTiming(
            hasTariff: computed.hasTariff,
            hasCycleData: computed.hasCycleData,
            activeIsCheapest: computed.activeIsCheapest,
            periods: computed.periods,
            pricingPeriods: computed.pricingPeriods,
            tariffTimeline: segments,
            nextCheaper: computed.nextCheaper,
            nextCheaperPhrase: computed.nextCheaperPhrase,
            nextStartPhraseByKey: computed.nextStartPhraseByKey
        )
    }

    static func lastNonNilSlotInstant(
        in days: [EnergyFlowDay],
        cycleStart: Date,
        cycleEnd: Date
    ) -> Date? {
        var latest: Date?
        for day in days {
            for (slotIndex, maybeGrid) in day.gridWh.enumerated() where maybeGrid != nil {
                let instant = day.dayStart.addingTimeInterval(TimeInterval(slotIndex) * slotSeconds)
                guard instant >= cycleStart, instant < cycleEnd else { continue }
                if let current = latest {
                    if instant > current { latest = instant }
                } else {
                    latest = instant
                }
            }
        }
        return latest
    }
}
