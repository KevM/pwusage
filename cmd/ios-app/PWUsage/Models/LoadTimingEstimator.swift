import Foundation

struct LoadTimingEstimator {
    enum StartNowUnavailableReason: Equatable { case invalidInput, incompleteTimeline, billingCycleExpired }

    struct StartNowSegment: Equatable {
        let periodKey: String
        let start: Date
        let end: Date
        let wallKwh: Double
        let surplusKwh: Double
        let boughtKwh: Double
        let total: Double
    }

    struct StartNowEstimate: Equatable {
        let total: Double
        let finishTime: Date
        let batteryKwh: Double
        let wallKwh: Double
        let durationHours: Double
        let segments: [StartNowSegment]
        let hasUnobservedBalance: Bool
    }

    struct CarChargeEstimate: Equatable {
        let batteryKwh: Double
        let wallKwh: Double
        let durationHours: Double
    }

    enum StartNowResult: Equatable {
        case estimate(StartNowEstimate)
        case unavailable(StartNowUnavailableReason)
        case noCharge
    }

    static func carChargeEstimate(settings: CarLoadSettings) -> CarChargeEstimate? {
        guard settings.capacityKwh.isFinite, settings.capacityKwh > 0,
              settings.capacityKwh <= LoadProfile.maximumCarCapacityKwh,
              settings.initialStateOfCharge.isFinite, (0...100).contains(settings.initialStateOfCharge),
              settings.targetStateOfCharge.isFinite, (settings.initialStateOfCharge...100).contains(settings.targetStateOfCharge) else {
            return nil
        }
        let batteryKwh = settings.capacityKwh * (settings.targetStateOfCharge - settings.initialStateOfCharge) / 100
        let power: Double
        let efficiency: Double
        switch settings.chargingLevel {
        case .level1: power = 1.5; efficiency = 0.85
        case .level2: power = 9; efficiency = 0.90
        }
        let wallKwh = batteryKwh / efficiency
        let durationHours = wallKwh / power
        guard batteryKwh.isFinite, wallKwh.isFinite, durationHours.isFinite else { return nil }
        return CarChargeEstimate(batteryKwh: batteryKwh, wallKwh: wallKwh, durationHours: durationHours)
    }

    /// Estimates a load beginning immediately. Appliances draw their energy evenly over their
    /// configured duration; car charging uses fixed average power/efficiency approximations.
    static func estimateStartNow(
        profile: LoadProfile,
        start: Date,
        tariffTimeline: [LoadTimingTariffSegment],
        observedBalances: [String: Double]
    ) -> StartNowResult {
        let batteryKwh: Double
        let wallKwh: Double
        let durationHours: Double

        if profile.kind == .car {
            guard let car = profile.carSettings,
                  let carEstimate = carChargeEstimate(settings: car) else {
                return .unavailable(.invalidInput)
            }
            batteryKwh = carEstimate.batteryKwh
            if batteryKwh == 0 { return .noCharge }
            wallKwh = carEstimate.wallKwh
            durationHours = carEstimate.durationHours
        } else {
            guard profile.energyKwh.isFinite, profile.energyKwh > 0,
                  profile.durationHours.isFinite, profile.durationHours > 0 else {
                return .unavailable(.invalidInput)
            }
            batteryKwh = 0
            wallKwh = profile.energyKwh
            durationHours = profile.durationHours
        }
        guard start.timeIntervalSince1970.isFinite, wallKwh.isFinite, wallKwh > 0,
              durationHours.isFinite, durationHours > 0 else { return .unavailable(.invalidInput) }

        let durationSeconds = durationHours * 3600
        let finish = start.addingTimeInterval(durationSeconds)
        guard durationSeconds.isFinite, finish.timeIntervalSince1970.isFinite else { return .unavailable(.invalidInput) }

        let timeline = tariffTimeline.sorted { $0.start < $1.start }
        var coveredUntil = start
        var relevant: [LoadTimingTariffSegment] = []
        for segment in timeline {
            guard segment.start.timeIntervalSince1970.isFinite, segment.end.timeIntervalSince1970.isFinite,
                  segment.end > segment.start, segment.buyRate.isFinite, segment.buyRate >= 0,
                  segment.sellRate.isFinite, segment.sellRate >= 0 else { return .unavailable(.invalidInput) }
            guard segment.end > start, segment.start < finish else { continue }
            let overlapStart = max(start, segment.start)
            let overlapEnd = min(finish, segment.end)
            guard overlapStart == coveredUntil else { return .unavailable(.incompleteTimeline) }
            relevant.append(segment)
            coveredUntil = overlapEnd
        }
        guard coveredUntil >= finish else { return .unavailable(.incompleteTimeline) }

        let powerKw = wallKwh / durationHours
        var surplusRemaining: [String: Double] = [:]
        var hasUnobservedBalance = false
        var breakdown: [StartNowSegment] = []
        var total = 0.0
        for segment in relevant {
            let overlapStart = max(start, segment.start)
            let overlapEnd = min(finish, segment.end)
            let segmentKwh = powerKw * (overlapEnd.timeIntervalSince(overlapStart) / 3600)
            let balance: Double
            if let existing = surplusRemaining[segment.periodKey] {
                balance = existing
            } else if let observed = observedBalances[segment.periodKey] {
                guard observed.isFinite else { return .unavailable(.invalidInput) }
                balance = max(observed, 0)
                surplusRemaining[segment.periodKey] = balance
            } else {
                balance = 0
                hasUnobservedBalance = true
                surplusRemaining[segment.periodKey] = 0
            }
            let surplus = min(segmentKwh, balance)
            let bought = segmentKwh - surplus
            let cost = surplus * segment.sellRate + bought * segment.buyRate
            guard segmentKwh.isFinite, cost.isFinite else { return .unavailable(.invalidInput) }
            surplusRemaining[segment.periodKey] = balance - surplus
            total += cost
            breakdown.append(StartNowSegment(periodKey: segment.periodKey, start: overlapStart, end: overlapEnd,
                wallKwh: segmentKwh, surplusKwh: surplus, boughtKwh: bought, total: cost))
        }
        guard total.isFinite else { return .unavailable(.invalidInput) }
        return .estimate(StartNowEstimate(total: total, finishTime: finish, batteryKwh: batteryKwh,
            wallKwh: wallKwh, durationHours: durationHours, segments: breakdown,
            hasUnobservedBalance: hasUnobservedBalance))
    }

    enum Verdict: Equatable {
        case covered
        case tight
        case partial
        case bought
        case unknown
    }

    struct Pricing: Equatable {
        let surplusKwh: Double
        let buyRate: Double
        let sellRate: Double
    }

    struct Cost: Equatable {
        let total: Double?
        let coveredKwh: Double
        let boughtKwh: Double
        let verdict: Verdict
    }

    struct Profile: Equatable, Identifiable {
        let id: String
        let label: String
        let kwh: Double
        let headroomKwh: Double
    }

    static let profiles: [Profile] = [
        .init(id: "laundry", label: "Laundry", kwh: 8, headroomKwh: 20),
        .init(id: "dishwasher", label: "Dishwasher", kwh: 5, headroomKwh: 5),
    ]

    static func carChargeKwh(capacityKwh: Double, currentPercent: Double, targetPercent: Double) -> Double {
        guard capacityKwh.isFinite, capacityKwh > 0,
              currentPercent.isFinite, targetPercent.isFinite else { return 0 }
        let current = min(max(currentPercent, 0), 100)
        let target = min(max(targetPercent, 0), 100)
        return capacityKwh * (max(target - current, 0) / 100)
    }

    static func chargeTargetPercent(targetPercent: Double, currentPercent: Double) -> Double {
        let target = (targetPercent / 10).rounded() * 10
        let minimum = (currentPercent / 10).rounded(.up) * 10
        return min(max(target, minimum), 100)
    }

    /// Keeps the limited-headroom cue proportional to a planned car charge (about 1.6× its energy).
    static func carHeadroomKwh(plannedKwh: Double) -> Double {
        guard plannedKwh.isFinite, plannedKwh > 0 else { return 0 }
        let threshold = plannedKwh * 1.6
        return threshold.isFinite ? threshold : .greatestFiniteMagnitude
    }

    static func boundedInput(_ value: Double, fallback: Double, range: ClosedRange<Double>) -> Double {
        guard value.isFinite else { return fallback }
        return min(max(value, range.lowerBound), range.upperBound)
    }

    static func shouldEstimateCarCharge(_ plannedKwh: Double) -> Bool {
        plannedKwh.isFinite && plannedKwh > 0
    }

    static func costToRun(_ loadKwh: Double, pricing: Pricing?, headroomKwh: Double? = nil) -> Cost {
        guard let pricing,
              loadKwh.isFinite, loadKwh >= 0,
              pricing.surplusKwh.isFinite,
              pricing.buyRate.isFinite,
              pricing.sellRate.isFinite else {
            return Cost(total: nil, coveredKwh: 0, boughtKwh: 0, verdict: .unknown)
        }
        guard pricing.buyRate != 0 || pricing.sellRate != 0 else {
            return Cost(total: nil, coveredKwh: 0, boughtKwh: 0, verdict: .unknown)
        }

        let covered = min(loadKwh, max(pricing.surplusKwh, 0))
        let bought = loadKwh - covered
        let total = covered * pricing.sellRate + bought * pricing.buyRate
        let verdict: Verdict
        if covered == 0 {
            verdict = .bought
        } else if bought > 0 {
            verdict = .partial
        } else if let headroomKwh, pricing.surplusKwh < headroomKwh {
            verdict = .tight
        } else {
            verdict = .covered
        }
        return Cost(total: total, coveredKwh: covered, boughtKwh: bought, verdict: verdict)
    }

    static func customAmount(_ amount: Double) -> Double {
        guard amount.isFinite else { return 1 }
        return min(max(amount, 1), 100)
    }

    static func profile(forHeadroom surplusKwh: Double) -> Profile? {
        profiles.first { surplusKwh >= $0.headroomKwh }
    }
}
