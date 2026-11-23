public struct ScenarioCosts: Equatable, Sendable {
    public let recorded: Double
    let batteryFixed: Double
    let solarAlone: Double
    let noSolar: Double

    public static let zero = ScenarioCosts(recorded: 0, batteryFixed: 0, solarAlone: 0, noSolar: 0)

    public init(recorded: Double, batteryFixed: Double, solarAlone: Double, noSolar: Double) {
        self.recorded = recorded
        self.batteryFixed = batteryFixed
        self.solarAlone = solarAlone
        self.noSolar = noSolar
    }

    static func + (lhs: ScenarioCosts, rhs: ScenarioCosts) -> ScenarioCosts {
        ScenarioCosts(
            recorded: lhs.recorded + rhs.recorded,
            batteryFixed: lhs.batteryFixed + rhs.batteryFixed,
            solarAlone: lhs.solarAlone + rhs.solarAlone,
            noSolar: lhs.noSolar + rhs.noSolar
        )
    }
}

public enum SavingsGapCause: Equatable, Sendable {
    case noFixedRatePlan, noRatePlan, noData
}

public struct SavingsDayRange: Equatable, Sendable {
    public let first: String
    public let last: String

    public init(first: String, last: String) {
        self.first = first
        self.last = last
    }
}

public struct SavingsCoverageGap: Equatable, Sendable {
    let cause: SavingsGapCause
    public let days: Int
    public let ranges: [SavingsDayRange]
    public let fixedRatePlanStart: String?

    public init(cause: SavingsGapCause, days: Int, ranges: [SavingsDayRange], fixedRatePlanStart: String?) {
        self.cause = cause
        self.days = days
        self.ranges = ranges
        self.fixedRatePlanStart = fixedRatePlanStart
    }
}

public struct SavingsFigures: Equatable, Sendable {
    public let costs: ScenarioCosts
    public var total: Double { costs.noSolar - costs.recorded }
    public var solar: Double { costs.noSolar - costs.solarAlone }
    public var powerwallAndRatePlan: Double { costs.solarAlone - costs.recorded }
    public var fixedRateSystem: Double { costs.noSolar - costs.batteryFixed }
    var fixedRateSolarAlone: Double { costs.noSolar - costs.solarAlone }
    public let daysWithData: Int
    public let daysInPeriod: Int
    let coverageGaps: [SavingsCoverageGap]
    /// Counted days with at least one slot priced on an estimated actual or reference plan.
    public let estimatedDays: Int

    public init(
        costs: ScenarioCosts,
        daysWithData: Int,
        daysInPeriod: Int,
        coverageGaps: [SavingsCoverageGap] = [],
        estimatedDays: Int = 0
    ) {
        self.costs = costs
        self.daysWithData = daysWithData
        self.daysInPeriod = daysInPeriod
        self.coverageGaps = coverageGaps
        self.estimatedDays = estimatedDays
    }

    public func gap(_ cause: SavingsGapCause) -> SavingsCoverageGap? {
        coverageGaps.first { $0.cause == cause }
    }
}
