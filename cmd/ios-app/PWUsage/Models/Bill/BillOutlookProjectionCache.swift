import Foundation

/// Keeps the latest bill projection, so a redraw caused by unrelated dashboard state
/// does not walk the rest of the billing cycle again. A projection stays good until an
/// input changes or the minute ticks over, the finest change the outlook shows.
@MainActor
final class BillOutlookProjectionCache {
    typealias Evaluate = @MainActor (
        BillOutlookHistory, LoadTimingForecastEstimator.PlanningContext, [SolarForecastInterval], Date, Date
    ) -> BillOutlook.ProjectionResult

    private struct Key: Equatable {
        let history: BillOutlookHistory
        let context: LoadTimingForecastEstimator.PlanningContext
        let forecast: [SolarForecastInterval]
        let minute: Int
        let cycleEnd: Date
    }

    private let evaluate: Evaluate
    private var latest: (key: Key, result: BillOutlook.ProjectionResult)?

    init(evaluate: @escaping Evaluate = BillOutlook.evaluate) {
        self.evaluate = evaluate
    }

    func result(history: BillOutlookHistory, context: LoadTimingForecastEstimator.PlanningContext,
                forecast: [SolarForecastInterval], now: Date, cycleEnd: Date) -> BillOutlook.ProjectionResult {
        let key = Key(history: history, context: context, forecast: forecast,
                      minute: Int((now.timeIntervalSince1970 / 60).rounded(.down)), cycleEnd: cycleEnd)
        if let latest, latest.key == key { return latest.result }
        let result = evaluate(history, context, forecast, now, cycleEnd)
        latest = (key, result)
        return result
    }
}
