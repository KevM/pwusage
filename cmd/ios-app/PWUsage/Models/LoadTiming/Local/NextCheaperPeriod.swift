import Foundation

struct CheaperPeriod: Equatable, Sendable {
    let name: String
    let startsAt: Date
    let marginalCost: Double
    let basis: MarginalCostBasis
}

struct ScheduleTransition: Equatable, Sendable {
    let start: Date
    let match: RatePeriodResolver.ScheduleMatch
}

struct CyclePeriodUsage: Equatable, Sendable {
    let periodName: String
    var gridWh: Double
    var buyRate: Double
    var sellRate: Double
}

extension NextCheaperPeriod {
    private static let hourSeconds: TimeInterval = 3600
    private static let daySeconds: TimeInterval = 86_400

    static func periodKey(_ name: String) -> String {
        name
    }

    static func walkScheduleTransitions(
        resolver: RatePeriodResolver,
        now: Date,
        timeZone: TimeZone,
        maxHorizonHours: Int
    ) -> [ScheduleTransition] {
        guard maxHorizonHours >= 1, let active = resolver.scheduleMatch(at: now) else {
            return []
        }

        var prevIdentity = active.windowIdentity
        var transitions: [ScheduleTransition] = []

        for hour in 1 ... maxHorizonHours {
            let cursor = now.addingTimeInterval(TimeInterval(hour) * hourSeconds)
            guard let match = resolver.scheduleMatch(at: cursor) else { continue }
            let identity = match.windowIdentity
            if identity == prevIdentity { continue }
            transitions.append(ScheduleTransition(
                start: snapToLocalHourStart(cursor, timeZone: timeZone),
                match: match
            ))
            prevIdentity = identity
        }
        return transitions
    }

    static func findNextCheaperPeriod(
        resolver: RatePeriodResolver,
        now: Date,
        cycle: [CyclePeriodUsage],
        timeZone: TimeZone,
        maxHorizonHours: Int = 48
    ) -> CheaperPeriod? {
        guard let active = resolver.scheduleMatch(at: now) else { return nil }

        let marginalByKey = buildMarginalByKey(cycle)
        let activeKey = periodKey(active.window.touName.rawValue)
        guard let activeMarginal = marginalByKey[activeKey],
              let activeCost = activeMarginal.marginalCost else {
            return nil
        }

        for transition in walkScheduleTransitions(
            resolver: resolver,
            now: now,
            timeZone: timeZone,
            maxHorizonHours: maxHorizonHours
        ) {
            let name = transition.match.window.touName.rawValue
            let key = periodKey(name)
            guard let marginal = marginalByKey[key], marginal.marginalCost != nil else { continue }
            let buyRate = transition.match.window.buyRate
            let sellRate = transition.match.window.sellRate
            let transitionCost = marginal.basis == .sell ? sellRate : buyRate
            if transitionCost < activeCost {
                return CheaperPeriod(
                    name: name,
                    startsAt: transition.start,
                    marginalCost: transitionCost,
                    basis: marginal.basis == .neutral ? .buy : marginal.basis
                )
            }
        }
        return nil
    }

    static func findNextStartsByKey(
        resolver: RatePeriodResolver,
        now: Date,
        cycle: [CyclePeriodUsage],
        timeZone: TimeZone,
        maxHorizonHours: Int = 24 * 7
    ) -> [String: Date] {
        var result: [String: Date] = [:]
        let targetKeys = Set(cycle.map { periodKey($0.periodName) })

        for transition in walkScheduleTransitions(
            resolver: resolver,
            now: now,
            timeZone: timeZone,
            maxHorizonHours: maxHorizonHours
        ) {
            let key = periodKey(transition.match.window.touName.rawValue)
            if targetKeys.contains(key), result[key] == nil {
                result[key] = transition.start
            }
        }
        return result
    }

    static func formatRelativeStart(start: Date, now: Date, timeZone: TimeZone) -> String {
        let startKey = dayKey(start, timeZone: timeZone)
        let nowKey = dayKey(now, timeZone: timeZone)
        let tomorrowKey = dayKey(now.addingTimeInterval(daySeconds), timeZone: timeZone)

        let time = makeFormatter(format: "h:mm a", timeZone: timeZone)
            .string(from: start)
            .replacingOccurrences(of: ":00", with: "")

        if startKey == nowKey {
            return "today at \(time)"
        }
        if startKey == tomorrowKey {
            return "tomorrow at \(time)"
        }

        let daysOut = Int((start.timeIntervalSince(now) / daySeconds).rounded())
        if daysOut < 7 {
            let weekday = makeFormatter(format: "EEEE", timeZone: timeZone).string(from: start)
            return "\(weekday) at \(time)"
        }

        let date = makeFormatter(format: "MMM d", timeZone: timeZone).string(from: start)
        return "\(date) at \(time)"
    }

    private static func buildMarginalByKey(_ cycle: [CyclePeriodUsage]) -> [String: MarginalCostResult] {
        var map: [String: MarginalCostResult] = [:]
        for entry in cycle {
            map[periodKey(entry.periodName)] = MarginalCost.compute(
                gridWh: entry.gridWh,
                buyRate: entry.buyRate,
                sellRate: entry.sellRate
            )
        }
        return map
    }

    private static func snapToLocalHourStart(_ cursor: Date, timeZone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let comps = calendar.dateComponents([.minute, .second, .nanosecond], from: cursor)
        let minute = comps.minute ?? 0
        let second = comps.second ?? 0
        let nanosecond = comps.nanosecond ?? 0
        let secondsIntoHour = TimeInterval(minute * 60 + second) + TimeInterval(nanosecond) / 1_000_000_000.0
        return cursor.addingTimeInterval(-secondsIntoHour)
    }

    private static func dayKey(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let comps = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", comps.year ?? 0, comps.month ?? 0, comps.day ?? 0)
    }

    private static func makeFormatter(format: String, timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = format
        return formatter
    }
}
