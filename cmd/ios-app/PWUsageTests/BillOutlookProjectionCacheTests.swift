import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Bill Outlook Projection Cache Tests")
struct BillOutlookProjectionCacheTests {
    /// On a minute boundary, so the next 59 seconds share its minute.
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func history(observedThrough: Date? = nil) -> BillOutlookHistory {
        BillOutlookHistory(points: [], observedThrough: observedThrough ?? start, complete: true, tariffTimeline: [])
    }

    private func context(asOf: Date? = nil) -> LoadTimingForecastEstimator.PlanningContext {
        .init(timeZone: "UTC", slots: [], asOf: asOf ?? start)
    }

    private func makeCache() -> (BillOutlookProjectionCache, () -> Int) {
        var evaluations = 0
        let cache = BillOutlookProjectionCache { _, _, _, _, _ in
            evaluations += 1
            return BillOutlook.ProjectionResult(points: [], usesSolar: evaluations.isMultiple(of: 2), usesHistory: true)
        }
        return (cache, { evaluations })
    }

    @Test("Unchanged inputs in the same minute reuse the projection")
    func reusesWithinMinute() {
        let (cache, evaluations) = makeCache()
        let first = cache.result(history: history(), context: context(), forecast: [], now: start,
                                 cycleEnd: start.addingTimeInterval(86400))
        let second = cache.result(history: history(), context: context(), forecast: [],
                                  now: start.addingTimeInterval(59), cycleEnd: start.addingTimeInterval(86400))
        #expect(evaluations() == 1)
        #expect(first.usesSolar == second.usesSolar)
    }

    @Test("A new minute recalculates")
    func recalculatesOnNewMinute() {
        let (cache, evaluations) = makeCache()
        let cycleEnd = start.addingTimeInterval(86400)
        _ = cache.result(history: history(), context: context(), forecast: [], now: start, cycleEnd: cycleEnd)
        _ = cache.result(history: history(), context: context(), forecast: [], now: start.addingTimeInterval(60),
                         cycleEnd: cycleEnd)
        #expect(evaluations() == 2)
    }

    @Test("Each changed input recalculates")
    func recalculatesOnChangedInputs() {
        let (cache, evaluations) = makeCache()
        let cycleEnd = start.addingTimeInterval(86400)
        let forecast = SolarForecastInterval(
            periodStart: start, periodEnd: start.addingTimeInterval(1800), powerKw: 1, cautiousPowerKw: nil)
        _ = cache.result(history: history(), context: context(), forecast: [], now: start, cycleEnd: cycleEnd)
        _ = cache.result(history: history(observedThrough: start.addingTimeInterval(1)), context: context(),
                         forecast: [], now: start, cycleEnd: cycleEnd)
        #expect(evaluations() == 2)
        _ = cache.result(history: history(), context: context(asOf: start.addingTimeInterval(1)), forecast: [],
                         now: start, cycleEnd: cycleEnd)
        #expect(evaluations() == 3)
        _ = cache.result(history: history(), context: context(), forecast: [forecast], now: start, cycleEnd: cycleEnd)
        #expect(evaluations() == 4)
        _ = cache.result(history: history(), context: context(), forecast: [], now: start,
                         cycleEnd: cycleEnd.addingTimeInterval(1))
        #expect(evaluations() == 5)
    }

    @Test("The first evaluation receives the caller's inputs")
    func passesInputsThrough() {
        var received: Date?
        let cache = BillOutlookProjectionCache { _, _, _, now, _ in
            received = now
            return .empty
        }
        _ = cache.result(history: history(), context: context(), forecast: [], now: start,
                         cycleEnd: start.addingTimeInterval(86400))
        #expect(received == start)
    }
}
