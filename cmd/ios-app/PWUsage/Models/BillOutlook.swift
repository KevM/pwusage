import Foundation

struct BillOutlookBucket: Codable, Equatable {
    let tariffName: String
    let periodName: String
    var netGridKwh: Double
    let buyRate: Double
    let sellRate: Double
    var key: String { tariffName + "\u{1f}" + periodName }
}
struct BillOutlookPeriod: Codable, Equatable {
    let tariffName: String
    let periodName: String
    var netGridKwh: Double
    var key: String { tariffName + "\u{1f}" + periodName }
}
struct BillOutlookPoint: Codable, Equatable {
    let date: Date
    let buckets: [BillOutlookBucket]
    let complete: Bool
    let estimatedCost: Double
    let periods: [BillOutlookPeriod]
}
struct BillOutlookTariff: Codable, Equatable {
    let start: Date
    let end: Date
    let periodKey: String
    let name: String
    let buyRate: Double
    let sellRate: Double
    let tariffName: String
    let periodName: String
    var segment: LoadTimingTariffSegment {
        .init(start: start, end: end, periodKey: periodKey, name: name, buyRate: buyRate, sellRate: sellRate)
    }
}
struct BillOutlookHistory: Codable, Equatable {
    let points: [BillOutlookPoint]
    let observedThrough: Date
    let complete: Bool
    var tariffTimeline: [BillOutlookTariff]
}

enum BillOutlook {
    /// Mirrors priceBillUsage: merge rate buckets first, then proportionally net each plan/period.
    static func cost(_ buckets: [BillOutlookBucket]) -> Double {
        Dictionary(grouping: merged(buckets), by: \.key).values.reduce(0) { total, group in
            let imports = group.reduce(0) { $0 + max($1.netGridKwh, 0) }
            let exports = group.reduce(0) { $0 + max(-$1.netGridKwh, 0) }
            let net = imports - exports
            return total + group.reduce(0) { sum, bucket in
                if net > 0 && bucket.netGridKwh > 0 {
                    return sum + bucket.netGridKwh * (net / imports) * bucket.buyRate
                }
                if net < 0 && bucket.netGridKwh < 0 {
                    return sum + bucket.netGridKwh * (-net / exports) * abs(bucket.sellRate)
                }
                return sum
            }
        }
    }
    private static func merged(_ buckets: [BillOutlookBucket]) -> [BillOutlookBucket] {
        var result: [BillOutlookBucket] = []
        for bucket in buckets {
            if let index = result.firstIndex(where: { $0.key == bucket.key && $0.buyRate == bucket.buyRate && $0.sellRate == bucket.sellRate }) {
                result[index].netGridKwh += bucket.netGridKwh
            } else { result.append(bucket) }
        }
        return result
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
    static func project(history: BillOutlookHistory, context: LoadTimingForecastEstimator.PlanningContext,
                        forecast: [SolarForecastInterval], now: Date, cycleEnd: Date) -> [BillOutlookPoint] {
        evaluate(history: history, context: context, forecast: forecast, now: now, cycleEnd: cycleEnd).points
    }
    static func evaluate(history: BillOutlookHistory, context: LoadTimingForecastEstimator.PlanningContext,
                        forecast: [SolarForecastInterval], now: Date, cycleEnd: Date) -> ProjectionResult {
        guard history.complete, let observed = history.points.last, observed.complete,
              observed.date == history.observedThrough, history.observedThrough <= now.addingTimeInterval(300),
              now.timeIntervalSince(history.observedThrough.addingTimeInterval(-LoadTimingForecastEstimator.observedIntervalDuration))
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
        let intervals = EnergyFlowProjection.intervals(from: history.observedThrough, to: cycleEnd, now: now,
            context: context, forecast: forecast, tariffs: tariffs.map(\.segment))
        var buckets = observed.buckets
        var points = [observed]
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: context.timeZone) ?? .gmt
        for interval in intervals {
            let tariff = tariffs[interval.tariffIndex]
            buckets = merged(buckets + [.init(tariffName: tariff.tariffName, periodName: tariff.periodName,
                netGridKwh: -interval.netExportKwh, buyRate: tariff.buyRate, sellRate: tariff.sellRate)])
            if calendar.startOfDay(for: interval.end) == interval.end || interval.end == intervals.last?.end {
                points.append(point(date: interval.end, buckets: buckets))
            }
        }
        guard let last = points.last, last.date > now else { return .empty }
        return .init(points: points, usesSolar: intervals.contains(where: \.usesSolar),
                     usesHistory: intervals.contains { !$0.usesSolar })
    }
}
