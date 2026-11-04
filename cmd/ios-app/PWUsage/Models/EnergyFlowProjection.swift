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

    /// Everything `intervals` needs about the window, the household and its pricing.
    struct Inputs {
        let start: Date
        let end: Date
        let now: Date
        let context: LoadTimingForecastEstimator.PlanningContext
        let forecast: [SolarForecastInterval]
        let tariffs: [LoadTimingTariffSegment]
    }

    static func intervals(_ inputs: Inputs) -> [Interval] {
        guard inputs.start < inputs.end, inputs.end.timeIntervalSince(inputs.start) <= 32 * 86400,
              let zone = TimeZone(identifier: inputs.context.timeZone),
              inputs.context.asOf <= inputs.now.addingTimeInterval(3600),
              inputs.now.timeIntervalSince(inputs.context.asOf) <= 86400 else { return [] }
        let sorted = inputs.forecast.sorted { $0.periodStart < $1.periodStart }
        guard isContiguous(sorted) else { return [] }
        let solar = solarWindow(in: sorted, from: inputs.start, now: inputs.now)
        let projection: LoadTimingForecastEstimator.Projection = solar.end > solar.start
            ? .forecast(intervals: sorted, context: inputs.context) : .history(context: inputs.context)
        let clock = LoadTimingForecastEstimator.WallClock(timeZone: zone, from: inputs.start, to: inputs.end)
        let model = LoadTimingForecastEstimator.FlowModel(projection: projection, clock: clock,
                                                          forecastStart: solar.start, forecastEnd: solar.end,
                                                          tariffs: inputs.tariffs)
        let edges = model.boundaries(from: inputs.start, to: inputs.end)
        var result: [Interval] = []
        for (lower, upper) in zip(edges, edges.dropFirst()) {
            let mid = lower.addingTimeInterval(upper.timeIntervalSince(lower) / 2)
            guard let index = inputs.tariffs.firstIndex(where: { $0.start <= lower && $0.end >= upper }),
                  let flow = model.flow(at: mid), flow.netExportKw.isFinite else { break }
            result.append(.init(start: lower, end: upper,
                                netExportKwh: flow.netExportKw * upper.timeIntervalSince(lower) / 3600,
                                tariffIndex: index, usesSolar: mid >= solar.start && mid < solar.end))
        }
        return result
    }

    /// A contiguous block of forecast intervals whose edges never overlap or go backwards.
    private static func isContiguous(_ sorted: [SolarForecastInterval]) -> Bool {
        var last: Date?
        return sorted.allSatisfy { interval in
            let previousEnd = last
            defer { last = interval.periodEnd }
            return interval.periodStart < interval.periodEnd && interval.powerKw.isFinite && interval.powerKw >= 0
                && (previousEnd.map { interval.periodStart >= $0 } ?? true)
        }
    }

    /// The forecast drives the projection only inside the contiguous block containing now.
    private static func solarWindow(in sorted: [SolarForecastInterval], from start: Date,
                                    now: Date) -> (start: Date, end: Date) {
        guard let index = sorted.firstIndex(where: { $0.periodStart <= now && $0.periodEnd > now }) else {
            return (start, start)
        }
        var first = index
        while first > 0, sorted[first - 1].periodEnd == sorted[first].periodStart { first -= 1 }
        var end = sorted[index].periodEnd
        for interval in sorted.dropFirst(index + 1) {
            guard interval.periodStart == end else { break }
            end = interval.periodEnd
        }
        return (max(start, sorted[first].periodStart),
                min(end, now.addingTimeInterval(LoadTimingForecastEstimator.forecastWindow)))
    }
}
