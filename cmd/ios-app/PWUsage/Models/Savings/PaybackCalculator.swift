import Foundation

enum SystemComponent: String, Sendable {
    case solar
    case powerwall

    /// The component's savings in one cycle, from its scenario costs.
    func savings(_ costs: ScenarioCosts) -> Double {
        switch self {
        case .solar: costs.noSolar - costs.solarAlone
        case .powerwall: costs.solarAlone - costs.recorded
        }
    }
}

enum BreakEven: Equatable, Sendable {
    /// Site-local first of the month in which the cumulative savings first reached the net cost.
    case paidOff(month: Date)
    /// Site-local first of the month in which the projection first reaches the net cost.
    case projected(month: Date)
    case notWithinHorizon
    case needsFullYear(countedDays: Int)
    case noCost
}

struct ComponentPayback: Equatable, Sendable {
    let component: SystemComponent
    let netCost: Double
    let paidToDate: Double
    /// YYYY-MM-DD the component's savings start.
    let since: String
    let breakEven: BreakEven
}

struct PaybackAssumptions: Equatable, Sendable {
    let rateGrowth: RateGrowth
    let solarDecline: Double
    let solarDeclineMeasured: Bool
    /// Nil when there is no Powerwall stream.
    let batteryFadePerYear: Double?
}

struct PaybackResult: Equatable, Sendable {
    let components: [ComponentPayback]
    /// Both components together. Nil unless both have a stream.
    /// Its `component` is not meaningful; read only its numbers and `since`.
    let combined: ComponentPayback?
    let assumptions: PaybackAssumptions
    let coverage: SavingsFigures
    /// YYYY-MM-DD of the first stored energy day when a component was installed earlier than stored history.
    var unrecordedBeforeDay: String?
}

/// What the break-even calculation reads: the report, the assumptions and the site's calendar.
struct PaybackContext {
    let report: SavingsReport
    let assumptions: PaybackAssumptions
    let calendar: Calendar
}

enum PaybackCalculator {
    static let minimumCountedDays = 300
    static let horizonYears = 30
    static let cyclesPerYear = 12
    static let horizonCycles = horizonYears * cyclesPerYear
    static let defaultSolarDecline = 0.005
    static let batteryFadePerYear = 0.03

    private static let maximumSolarDeclinePercent = 2.0

    /// Price less incentives, less the tax credit on what remains after incentives. A nil credit is off.
    static func netCost(_ cost: SystemCostDTO) -> Double {
        let afterIncentives = cost.price - cost.incentives
        let credit = (cost.taxCreditPercent ?? 0) / 100 * max(0, afterIncentives)
        return afterIncentives - credit
    }

    /// The pre-filled credit for an install year; nil once the credit has ended.
    static func defaultTaxCreditPercent(installYear: Int) -> Double? {
        switch installYear {
        case ...2019: 30
        case 2020 ... 2021: 26
        case 2022 ... 2025: 30
        default: nil
        }
    }

    /// The yearly solar output decline as a fraction. Uses the Panel Health measurement when it has a
    /// confidence; otherwise the typical rate. Improving output counts as no decline.
    static func solarDecline(_ change: SolarHealthReport.ChangeOverTime?) -> (rate: Double, measured: Bool) {
        guard let change, change.agingConfidence != nil, let perYear = change.agingPercentPerYear else {
            return (defaultSolarDecline, false)
        }
        let percent = min(max(-perYear, 0), maximumSolarDeclinePercent)
        return (percent / 100, true)
    }

    /// Payback for each component with a cost and a start day. Nil when no component qualifies.
    /// A Powerwall cost with no install date and no battery flow has no start, so it is left out.
    static func compute(
        report: SavingsReport,
        costs: SystemCostsDTO,
        change: SolarHealthReport.ChangeOverTime?,
        timeZone: TimeZone,
        now: Date
    ) -> PaybackResult? {
        let calendar = calendar(in: timeZone)
        let streams = streams(report: report, costs: costs, calendar: calendar, now: now)
        guard !streams.isEmpty else { return nil }

        let decline = solarDecline(change)
        let assumptions = PaybackAssumptions(
            rateGrowth: report.rateGrowth,
            solarDecline: decline.rate,
            solarDeclineMeasured: decline.measured,
            batteryFadePerYear: streams.contains { $0.component == .powerwall } ? batteryFadePerYear : nil
        )
        let context = PaybackContext(report: report, assumptions: assumptions, calendar: calendar)
        let components = streams.map { stream in
            payback(for: [stream], since: stream.since, context: context)
        }
        let combined = streams.count == 2 ? payback(for: streams, since: earliestSince(streams), context: context) : nil
        let unrecordedBeforeDay = unrecordedStart(
            streams: streams, firstStoredDay: report.firstStoredDay, calendar: calendar
        )
        return PaybackResult(
            components: components,
            combined: combined,
            assumptions: assumptions,
            coverage: report.solarSinceInstall,
            unrecordedBeforeDay: unrecordedBeforeDay
        )
    }

    private static func unrecordedStart(
        streams: [PaybackStream], firstStoredDay: Date?, calendar: Calendar
    ) -> String? {
        guard let firstStoredDay,
              let earliest = streams.min(by: { $0.start < $1.start }),
              earliest.start < calendar.startOfDay(for: firstStoredDay) else {
            return nil
        }
        return RatePlanTimelineFormatting.formatYMD(firstStoredDay, in: calendar.timeZone)
    }

    static func calendar(in timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    // MARK: Streams

    private static func streams(
        report: SavingsReport, costs: SystemCostsDTO, calendar: Calendar, now: Date
    ) -> [PaybackStream] {
        var streams: [PaybackStream] = []
        if let cost = costs.solar,
           let stream = makeStream(.solar, cost: cost, since: cost.installDate ?? costs.siteInstalled,
                                   calendar: calendar, now: now) {
            streams.append(stream)
        }
        if let cost = costs.powerwall,
           let since = cost.installDate ?? report.batteryStartDay,
           let stream = makeStream(.powerwall, cost: cost, since: since, calendar: calendar, now: now) {
            streams.append(stream)
        }
        return streams
    }

    private static func makeStream(
        _ component: SystemComponent, cost: SystemCostDTO, since: String, calendar: Calendar, now: Date
    ) -> PaybackStream? {
        guard let noon = RatePlanTimelineFormatting.parseYMD(since, in: calendar.timeZone) else { return nil }
        let start = calendar.startOfDay(for: noon)
        let ageYears = max(0, now.timeIntervalSince(start)) / 86_400 / 365.25
        return PaybackStream(
            component: component,
            netCost: netCost(cost),
            since: since,
            start: start,
            ageYears: ageYears
        )
    }

    private static func earliestSince(_ streams: [PaybackStream]) -> String {
        streams.min { $0.start < $1.start }?.since ?? ""
    }

    // MARK: Payback

    private static func payback(
        for streams: [PaybackStream], since: String, context: PaybackContext
    ) -> ComponentPayback {
        let netCost = streams.reduce(0) { $0 + $1.netCost }
        let paid = paidToDate(streams, context: context)
        return ComponentPayback(
            component: streams[0].component,
            netCost: netCost,
            paidToDate: paid,
            since: since,
            breakEven: breakEven(streams, netCost: netCost, paid: paid, context: context)
        )
    }

    private static func paidToDate(_ streams: [PaybackStream], context: PaybackContext) -> Double {
        context.report.cycles.reduce(0) { $0 + contribution(of: streams, in: $1) }
    }

    /// The streams' savings in one cycle. A stream counts from the cycle containing its start, in full.
    private static func contribution(of streams: [PaybackStream], in cycle: CycleSavings) -> Double {
        streams.reduce(0) { total, stream in
            stream.start < cycle.end ? total + stream.component.savings(cycle.costs) : total
        }
    }

    private static func breakEven(
        _ streams: [PaybackStream], netCost: Double, paid: Double, context: PaybackContext
    ) -> BreakEven {
        guard netCost > 0 else { return .noCost }
        if paid >= netCost, let month = paidOffMonth(streams, netCost: netCost, context: context) {
            return .paidOff(month: month)
        }
        let countedDays = context.report.year.daysWithData
        guard countedDays >= minimumCountedDays else { return .needsFullYear(countedDays: countedDays) }
        guard let month = context.projectedMonth(streams, netCost: netCost, paid: paid) else {
            return .notWithinHorizon
        }
        return .projected(month: month)
    }

    private static func paidOffMonth(
        _ streams: [PaybackStream], netCost: Double, context: PaybackContext
    ) -> Date? {
        var cumulative = 0.0
        for cycle in context.report.cycles {
            cumulative += contribution(of: streams, in: cycle)
            if cumulative >= netCost {
                return context.billingMonth(closedAt: cycle.end)
            }
        }
        return nil
    }
}

/// The savings clock of one component: its start day, the net cost it must recover and its age.
struct PaybackStream: Equatable, Sendable {
    let component: SystemComponent
    let netCost: Double
    /// YYYY-MM-DD the component's savings start.
    let since: String
    let start: Date
    /// Years from `start` to now. Drives Powerwall capacity fade.
    let ageYears: Double
}
