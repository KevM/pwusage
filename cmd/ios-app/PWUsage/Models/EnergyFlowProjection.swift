import Foundation

/// Shared household baseline, independent of a Smart Shift job or its pricing rules.
struct EnergyFlowProjection {
    struct Interval {
        let start: Date
        let end: Date
        let netExportKwh: Double
        let tariffIndex: Int
        let usesSolar: Bool
    }
    static func intervals(from start: Date, to end: Date, now: Date,
                          context: LoadTimingForecastEstimator.PlanningContext,
                          forecast: [SolarForecastInterval], tariffs: [LoadTimingTariffSegment]) -> [Interval] {
        guard start < end, end.timeIntervalSince(start) <= 32 * 86400,
              let zone = TimeZone(identifier: context.timeZone),
              context.asOf <= now.addingTimeInterval(3600), now.timeIntervalSince(context.asOf) <= 86400 else { return [] }
        let sorted = forecast.sorted { $0.periodStart < $1.periodStart }
        var last: Date?
        guard sorted.allSatisfy({ interval in
            defer { last = interval.periodEnd }
            return interval.periodStart < interval.periodEnd && interval.powerKw.isFinite && interval.powerKw >= 0
                && (last == nil || interval.periodStart >= last!)
        }) else { return [] }
        // Only a contiguous block containing now is presented as a solar forecast.
        var forecastStart = start, forecastEnd = start
        if let index = sorted.firstIndex(where: { $0.periodStart <= now && $0.periodEnd > now }) {
            var first = index
            while first > 0 && sorted[first - 1].periodEnd == sorted[first].periodStart { first -= 1 }
            forecastStart = max(start, sorted[first].periodStart)
            forecastEnd = sorted[index].periodEnd
            for interval in sorted.dropFirst(index + 1) {
                guard interval.periodStart == forecastEnd else { break }
                forecastEnd = interval.periodEnd
            }
            forecastEnd = min(forecastEnd, now.addingTimeInterval(LoadTimingForecastEstimator.forecastWindow))
        }
        let projection: LoadTimingForecastEstimator.Projection = forecastEnd > forecastStart
            ? .forecast(intervals: sorted, context: context) : .history(context: context)
        let clock = LoadTimingForecastEstimator.WallClock(timeZone: zone, from: start, to: end)
        let model = LoadTimingForecastEstimator.FlowModel(projection: projection, clock: clock,
            forecastStart: forecastStart, forecastEnd: forecastEnd, tariffs: tariffs)
        let edges = model.boundaries(from: start, to: end)
        var result: [Interval] = []
        for (a, b) in zip(edges, edges.dropFirst()) {
            let mid = a.addingTimeInterval(b.timeIntervalSince(a) / 2)
            guard let index = tariffs.firstIndex(where: { $0.start <= a && $0.end >= b }),
                  let flow = model.flow(at: mid), flow.netExportKw.isFinite else { break }
            result.append(.init(start: a, end: b, netExportKwh: flow.netExportKw * b.timeIntervalSince(a) / 3600,
                                tariffIndex: index, usesSolar: mid >= forecastStart && mid < forecastEnd))
        }
        return result
    }
}
