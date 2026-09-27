import Foundation

/// Compares saved loads against the same observed billing-cycle snapshot.
struct LoadTimingRecommendation: Equatable {
    enum State: Equatable {
        case ready
        case noFit
        case incompleteData
        case stale
        case noEnergyNeeded
        case noCandidates
    }

    struct Candidate: Equatable {
        let profile: LoadProfile
        let result: LoadTimingEstimator.StartNowResult
        let remainingSurplusKwh: Double?

        var estimate: LoadTimingEstimator.StartNowEstimate? {
            guard case let .estimate(estimate) = result else { return nil }
            return estimate
        }

        var surplusKwh: Double {
            estimate?.segments.reduce(0) { $0 + $1.surplusKwh } ?? 0
        }

        var boughtKwh: Double {
            estimate?.segments.reduce(0) { $0 + $1.boughtKwh } ?? 0
        }

        var fitsSurplus: Bool {
            guard let estimate, estimate.wallKwh > 0, !estimate.hasUnobservedBalance else { return false }
            return boughtKwh <= LoadTimingRecommendation.energyToleranceKwh
        }
    }

    let candidates: [Candidate]
    let suggested: Candidate?
    let state: State

    private static let energyToleranceKwh = 0.000_001
    private static let detailFreshnessWindow: TimeInterval = 60 * 60

    static func evaluate(
        profiles: [LoadProfile],
        start: Date,
        timing: LoadTiming,
        energyDataThrough: Date?,
        cycleEnd: Date,
        refreshUnavailable: Bool
    ) -> Self {
        guard !profiles.isEmpty else {
            return Self(candidates: [], suggested: nil, state: .noCandidates)
        }

        let observedBalances: [String: Double] = timing.hasCycleData
            ? timing.periods.reduce(into: [:]) { balances, period in balances[period.name] = period.cycleNetExportKwh }
            : [:]

        let candidates = profiles.map { profile -> Candidate in
            let result: LoadTimingEstimator.StartNowResult
            if profile.kind == .car,
               let settings = profile.carSettings,
               let carEstimate = LoadTimingEstimator.carChargeEstimate(settings: settings),
               carEstimate.batteryKwh == 0 {
                result = .noCharge
            } else if !timing.hasTariff {
                result = .unavailable(.incompleteTimeline)
            } else {
                let estimate = LoadTimingEstimator.estimateStartNow(
                    profile: profile,
                    start: start,
                    tariffTimeline: timing.tariffTimeline,
                    observedBalances: observedBalances
                )
                if case let .estimate(value) = estimate, value.finishTime > cycleEnd {
                    result = .unavailable(.billingCycleExpired)
                } else if start >= cycleEnd {
                    result = .unavailable(.billingCycleExpired)
                } else {
                    result = estimate
                }
            }
            return Candidate(profile: profile, result: result,
                remainingSurplusKwh: remainingSurplus(for: result, observedBalances: observedBalances))
        }

        if candidates.allSatisfy({ $0.result == .noCharge }) {
            return Self(candidates: candidates, suggested: nil, state: .noEnergyNeeded)
        }

        let hasFreshObservations = isFresh(energyDataThrough, relativeTo: start) && !refreshUnavailable
        let eligible = candidates.filter(\.fitsSurplus)
        let winner = eligible.enumerated().max { left, right in
            let leftEnergy = left.element.estimate?.wallKwh ?? 0
            let rightEnergy = right.element.estimate?.wallKwh ?? 0
            if leftEnergy == rightEnergy { return left.offset > right.offset }
            return leftEnergy < rightEnergy
        }?.element

        if let winner {
            return Self(candidates: candidates, suggested: hasFreshObservations ? winner : nil,
                state: hasFreshObservations ? .ready : .stale)
        }

        let hasIncompleteData = candidates.contains { candidate in
            if case .unavailable(.incompleteTimeline) = candidate.result { return true }
            if case .unavailable(.billingCycleExpired) = candidate.result { return true }
            if candidate.estimate?.hasUnobservedBalance == true { return true }
            return false
        }
        if hasIncompleteData {
            return Self(candidates: candidates, suggested: nil, state: .incompleteData)
        }
        let hasAssessedSurplus = candidates.contains { candidate in
            guard let estimate = candidate.estimate else { return false }
            return !estimate.hasUnobservedBalance
        }
        if hasAssessedSurplus && !hasFreshObservations {
            return Self(candidates: candidates, suggested: nil, state: .stale)
        }
        return Self(candidates: candidates, suggested: nil, state: .noFit)
    }

    func exploredProfile(explicitID: String?) -> Candidate? {
        if let explicitID, let selected = candidates.first(where: { $0.profile.id == explicitID }) {
            return selected
        }
        return suggested ?? candidates.first
    }

    private static func isFresh(_ sourceTime: Date?, relativeTo start: Date) -> Bool {
        guard let sourceTime,
              sourceTime.timeIntervalSince1970.isFinite,
              start.timeIntervalSince1970.isFinite else { return false }
        let age = start.timeIntervalSince(sourceTime)
        return age >= 0 && age <= detailFreshnessWindow
    }

    private static func remainingSurplus(
        for result: LoadTimingEstimator.StartNowResult,
        observedBalances: [String: Double]
    ) -> Double? {
        guard case let .estimate(estimate) = result else {
            if case .noCharge = result { return 0 }
            return nil
        }

        let touchedKeys = Set(estimate.segments.map(\.periodKey))
        var remaining = 0.0
        for key in touchedKeys {
            guard let observed = observedBalances[key], observed.isFinite else { return nil }
            let available = max(observed, 0)
            let consumed = estimate.segments
                .filter { $0.periodKey == key }
                .reduce(0) { $0 + $1.surplusKwh }
            remaining += max(available - consumed, 0)
        }
        return remaining
    }
}
