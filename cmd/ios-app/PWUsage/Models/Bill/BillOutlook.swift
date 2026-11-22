import Foundation
import PWUsageCore

enum BillOutlook {
    /// Mirrors priceBillUsage: merge rate buckets first, then proportionally net each plan/period.
    static func cost(_ buckets: [BillOutlookBucket]) -> Double {
        BillOutlookHistoryBuilder.cost(buckets)
    }
    static func point(date: Date, buckets: [BillOutlookBucket]) -> BillOutlookPoint {
        let periods = Dictionary(grouping: buckets, by: \.key).values.compactMap { group -> BillOutlookPeriod? in
            guard let first = group.first else { return nil }
            return .init(tariffName: first.tariffName, periodName: first.periodName,
                         netGridKwh: group.reduce(0) { $0 + $1.netGridKwh })
        }.sorted { $0.key < $1.key }
        return .init(date: date, buckets: buckets, complete: true, estimatedCost: cost(buckets), periods: periods)
    }
    struct ProjectionResult {
        let points: [BillOutlookPoint]
        let usesSolar: Bool
        let usesHistory: Bool
        static let empty = ProjectionResult(points: [], usesSolar: false, usesHistory: false)
    }
    static func evaluate(history: BillOutlookHistory, context: LoadTimingForecastEstimator.PlanningContext,
                         forecast: [SolarForecastInterval], now: Date, cycleEnd: Date) -> ProjectionResult {
        guard history.complete, let observed = history.points.last, observed.complete,
              observed.date == history.observedThrough, history.observedThrough <= now.addingTimeInterval(300),
              now.timeIntervalSince(
                  history.observedThrough.addingTimeInterval(-LoadTimingForecastEstimator.observedIntervalDuration)
              )
              <= (forecast.isEmpty || context.hasGridHistory
                  ? LoadTimingForecastEstimator.maximumFlatBalanceAge : LoadTimingForecastEstimator.maximumBalanceAge),
              cycleEnd > now, history.observedThrough < cycleEnd,
              observed.buckets.allSatisfy({ $0.netGridKwh.isFinite && $0.buyRate.isFinite && $0.sellRate.isFinite }),
              !history.tariffTimeline.isEmpty else { return .empty }
        let tariffs = history.tariffTimeline
        for (index, tariff) in tariffs.enumerated() {
            guard tariff.start < tariff.end, tariff.buyRate.isFinite, tariff.sellRate.isFinite,
                  index == 0 || tariff.start >= tariffs[index - 1].end else { return .empty }
        }
        let intervals = EnergyFlowProjection.intervals(.init(
            start: history.observedThrough, end: cycleEnd, now: now,
            context: context, forecast: forecast, tariffs: tariffs.map(\.segment)
        ))
        var buckets = observed.buckets
        var points = [observed]
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: context.timeZone) ?? .gmt
        for interval in intervals {
            let tariff = tariffs[interval.tariffIndex]
            buckets = BillOutlookHistoryBuilder.merged(
                buckets + [.init(tariffName: tariff.tariffName, periodName: tariff.periodName,
                                 netGridKwh: -interval.netExportKwh, buyRate: tariff.buyRate,
                                 sellRate: tariff.sellRate)])
            if calendar.startOfDay(for: interval.end) == interval.end || interval.end == intervals.last?.end {
                points.append(point(date: interval.end, buckets: buckets))
            }
        }
        // The recorded point can sit ahead of `now` while its sample is in progress; it is not a projection.
        guard !intervals.isEmpty, let last = points.last, last.date > history.observedThrough, last.date > now
        else { return .empty }
        return .init(points: points, usesSolar: intervals.contains(where: \.usesSolar),
                     usesHistory: intervals.contains { !$0.usesSolar })
    }
}
