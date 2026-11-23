import Foundation

public enum LoadTimingCalculator {
    private struct ActivePeriod {
        let name: String
    }

    private struct PeriodRate {
        let name: String
        let buyRate: Double
        let sellRate: Double
    }

    private struct TimingContext {
        let activePeriod: ActivePeriod
        let groupedCycle: [CyclePeriodUsage]
        let pricingCycle: [CyclePeriodUsage]
        let hasCycleData: Bool
    }

    private struct ScheduleHints {
        let activeIsCheapest: Bool
        let nextCheaper: NextCheaperPeriod?
        let nextCheaperPhrase: String?
        let nextStartPhraseByKey: [String: String]

        static let empty = ScheduleHints(
            activeIsCheapest: false,
            nextCheaper: nil,
            nextCheaperPhrase: nil,
            nextStartPhraseByKey: [:]
        )
    }

    public static func compute(
        buckets: [BillUsageBucket],
        costs _: [Double],
        resolver: RatePeriodResolver,
        now: Date,
        timeZone: TimeZone
    ) -> LoadTiming? {
        guard let activeMatch = resolver.scheduleMatch(at: now),
              let activePeriod = resolveActivePeriod(match: activeMatch) else {
            return nil
        }

        let context = buildContext(
            buckets: buckets,
            activeMatch: activeMatch,
            activePeriod: activePeriod
        )
        let hints = context.hasCycleData
            ? computeHints(context: context, resolver: resolver, now: now, timeZone: timeZone)
            : .empty

        let periods = context.groupedCycle.map {
            makeLoadTimingPeriod(
                entry: $0,
                activePeriodName: activePeriod.name,
                nextStartPhraseByKey: hints.nextStartPhraseByKey
            )
        }
        let pricingPeriods = context.pricingCycle.map {
            makeLoadTimingPeriod(
                entry: $0,
                activePeriodName: activePeriod.name,
                nextStartPhraseByKey: hints.nextStartPhraseByKey
            )
        }

        return LoadTiming(
            hasTariff: true,
            hasCycleData: context.hasCycleData,
            activeIsCheapest: hints.activeIsCheapest,
            periods: periods,
            pricingPeriods: pricingPeriods,
            tariffTimeline: [],
            nextCheaper: hints.nextCheaper,
            nextCheaperPhrase: hints.nextCheaperPhrase,
            nextStartPhraseByKey: hints.nextStartPhraseByKey
        )
    }

    private static func computeHints(
        context: TimingContext,
        resolver: RatePeriodResolver,
        now: Date,
        timeZone: TimeZone
    ) -> ScheduleHints {
        var nextCheaper: NextCheaperPeriod?
        var nextCheaperPhrase: String?
        if let cheaper = NextCheaperPeriod.findNextCheaperPeriod(
            resolver: resolver,
            now: now,
            cycle: context.groupedCycle,
            timeZone: timeZone
        ) {
            let phrase = NextCheaperPeriod.formatRelativeStart(
                start: cheaper.startsAt,
                now: now,
                timeZone: timeZone
            )
            nextCheaper = NextCheaperPeriod(
                name: cheaper.name,
                marginalCost: cheaper.marginalCost,
                phrase: phrase
            )
            nextCheaperPhrase = phrase
        }

        let nextStarts = NextCheaperPeriod.findNextStartsByKey(
            resolver: resolver,
            now: now,
            cycle: context.pricingCycle,
            timeZone: timeZone
        )
        let nextStartPhraseByKey = nextStarts.mapValues {
            NextCheaperPeriod.formatRelativeStart(start: $0, now: now, timeZone: timeZone)
        }

        let activeIsCheapest = computeActiveIsCheapest(
            groupedCycle: context.groupedCycle,
            activePeriodName: context.activePeriod.name
        )

        return ScheduleHints(
            activeIsCheapest: activeIsCheapest,
            nextCheaper: nextCheaper,
            nextCheaperPhrase: nextCheaperPhrase,
            nextStartPhraseByKey: nextStartPhraseByKey
        )
    }

    private static func resolveActivePeriod(match: RatePeriodResolver.ScheduleMatch) -> ActivePeriod? {
        let seasonWindows = match.season.weekdayPeriods + match.season.weekendPeriods
        let seasonRatesFinite = seasonWindows.allSatisfy {
            $0.buyRate.isFinite && $0.sellRate.isFinite
        }
        guard seasonRatesFinite, match.window.buyRate.isFinite, match.window.sellRate.isFinite else {
            return nil
        }
        return ActivePeriod(name: match.window.touName.rawValue)
    }

    private static func buildContext(
        buckets: [BillUsageBucket],
        activeMatch: RatePeriodResolver.ScheduleMatch,
        activePeriod: ActivePeriod
    ) -> TimingContext {
        var grouped: [CyclePeriodUsage] = []
        var indexByName: [String: Int] = [:]

        for bucket in buckets {
            let name = bucket.periodName.isEmpty ? "Unknown" : bucket.periodName
            if let existingIndex = indexByName[name] {
                grouped[existingIndex].gridWh += bucket.gridWh
            } else {
                indexByName[name] = grouped.count
                grouped.append(CyclePeriodUsage(
                    periodName: name,
                    gridWh: bucket.gridWh,
                    buyRate: bucket.buyRate,
                    sellRate: bucket.sellRate
                ))
            }
        }

        var currentRates: [PeriodRate] = []
        var rateByName: [String: PeriodRate] = [:]
        for window in activeMatch.season.weekdayPeriods + activeMatch.season.weekendPeriods {
            let name = window.touName.rawValue
            if rateByName[name] == nil {
                let rate = PeriodRate(name: name, buyRate: window.buyRate, sellRate: window.sellRate)
                rateByName[name] = rate
                currentRates.append(rate)
            }
        }

        for index in grouped.indices {
            if let rate = rateByName[grouped[index].periodName] {
                grouped[index].buyRate = rate.buyRate
                grouped[index].sellRate = rate.sellRate
            }
        }

        let filteredCycle = grouped.filter { rateByName[$0.periodName] != nil }
        var pricingCycle = filteredCycle
        let seenNames = Set(filteredCycle.map(\.periodName))
        for rate in currentRates where !seenNames.contains(rate.name) {
            pricingCycle.append(CyclePeriodUsage(
                periodName: rate.name,
                gridWh: 0,
                buyRate: rate.buyRate,
                sellRate: rate.sellRate
            ))
        }

        return TimingContext(
            activePeriod: activePeriod,
            groupedCycle: filteredCycle,
            pricingCycle: pricingCycle,
            hasCycleData: !buckets.isEmpty
        )
    }

    private static func computeActiveIsCheapest(
        groupedCycle: [CyclePeriodUsage],
        activePeriodName: String
    ) -> Bool {
        guard let activeEntry = groupedCycle.first(where: { $0.periodName == activePeriodName }),
              let activeMarginal = MarginalCost.compute(
                  gridWh: activeEntry.gridWh,
                  buyRate: activeEntry.buyRate,
                  sellRate: activeEntry.sellRate
              ).marginalCost else {
            return false
        }
        return groupedCycle.allSatisfy { entry in
            if entry.periodName == activePeriodName {
                return true
            }
            let cost = MarginalCost.compute(
                gridWh: entry.gridWh,
                buyRate: entry.buyRate,
                sellRate: entry.sellRate
            ).marginalCost
            return cost.map { $0 >= activeMarginal } ?? true
        }
    }

    private static func makeLoadTimingPeriod(
        entry: CyclePeriodUsage,
        activePeriodName: String,
        nextStartPhraseByKey: [String: String]
    ) -> LoadTimingPeriod {
        let marginal = MarginalCost.compute(
            gridWh: entry.gridWh,
            buyRate: entry.buyRate,
            sellRate: entry.sellRate
        )
        let isActive = entry.periodName == activePeriodName
        let key = NextCheaperPeriod.periodKey(entry.periodName)
        return LoadTimingPeriod(
            name: entry.periodName,
            marginalCost: marginal.marginalCost,
            basis: marginal.basis.rawValue,
            cycleNetExportKwh: marginal.cycleNetExportKwh,
            isActive: isActive,
            nextStartPhrase: isActive ? nil : nextStartPhraseByKey[key],
            buyRate: entry.buyRate,
            sellRate: entry.sellRate
        )
    }
}
