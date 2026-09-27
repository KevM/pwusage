import Foundation

/// The single selected-profile result shown by the load timing screen.
struct LoadTimingAffordance: Equatable {
    let profile: LoadProfile
    let result: LoadTimingEstimator.StartNowResult

    static func evaluate(
        profile: LoadProfile,
        start: Date,
        timing: LoadTiming,
        observedBalances: [String: Double]
    ) -> LoadTimingAffordance {
        LoadTimingAffordance(
            profile: profile,
            result: LoadTimingEstimator.estimateStartNow(
                profile: profile,
                start: start,
                tariffTimeline: timing.tariffTimeline,
                observedBalances: observedBalances
            )
        )
    }
}
