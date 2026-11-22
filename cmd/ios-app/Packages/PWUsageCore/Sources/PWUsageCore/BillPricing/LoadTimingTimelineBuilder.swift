import Foundation

public enum LoadTimingTimelineBuilder {
    private struct ResolvedPeriod {
        let identity: RatePeriodResolver.WindowIdentity
        let periodKey: String
        let name: String
        let buyRate: Double
        let sellRate: Double

        func isSamePeriod(as other: ResolvedPeriod) -> Bool {
            identity == other.identity && buyRate == other.buyRate && sellRate == other.sellRate
        }

        func toSegment(start: Date, end: Date) -> LoadTimingTariffSegment {
            LoadTimingTariffSegment(
                start: start,
                end: end,
                periodKey: periodKey,
                name: name,
                buyRate: buyRate,
                sellRate: sellRate
            )
        }
    }

    public static func segments(
        resolver: RatePeriodResolver,
        from start: Date,
        to horizonEnd: Date,
        now: Date
    ) -> [LoadTimingTariffSegment] {
        segments(resolver: resolver, from: start, to: horizonEnd, requiredEnd: now)
    }

    public static func segments(
        resolver: RatePeriodResolver,
        from start: Date,
        to horizonEnd: Date,
        requiredEnd: Date
    ) -> [LoadTimingTariffSegment] {
        guard horizonEnd > start,
              let first = resolvePeriod(resolver: resolver, at: start) else {
            return []
        }

        var result: [LoadTimingTariffSegment] = []
        var segmentStart = start
        var current = first

        for instant in candidateInstants(resolver: resolver, start: start, end: horizonEnd) {
            let resolved = resolvePeriod(resolver: resolver, at: instant)
            if let resolved, current.isSamePeriod(as: resolved) {
                continue
            }
            result.append(current.toSegment(start: segmentStart, end: instant))
            guard let resolved else {
                return instant >= requiredEnd ? result : []
            }
            segmentStart = instant
            current = resolved
        }

        result.append(current.toSegment(start: segmentStart, end: horizonEnd))
        return result
    }

    private static func candidateInstants(
        resolver: RatePeriodResolver,
        start: Date,
        end: Date
    ) -> [Date] {
        let timeZone = resolver.siteTimeZone
        let minutes = resolver.boundaryMinutes()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone

        var instants: Set<TimeInterval> = []
        let startSeconds = start.timeIntervalSince1970
        let endSeconds = end.timeIntervalSince1970
        let insertIfInside: (Date?) -> Void = { date in
            guard let date else { return }
            let timestamp = date.timeIntervalSince1970
            if timestamp > startSeconds, timestamp < endSeconds {
                instants.insert(timestamp)
            }
        }

        var dayStart = calendar.startOfDay(for: start)
        let lastDay = calendar.startOfDay(for: end)
        while dayStart <= lastDay {
            let dayComps = calendar.dateComponents([.year, .month, .day], from: dayStart)
            for minute in minutes {
                var target = dayComps
                target.hour = minute / 60
                target.minute = minute % 60
                target.second = 0
                insertIfInside(calendar.date(from: target))
                let anchor = dayStart.addingTimeInterval(-1)
                insertIfInside(calendar.nextDate(
                    after: anchor,
                    matching: target,
                    matchingPolicy: .nextTime,
                    repeatedTimePolicy: .first
                ))
                insertIfInside(calendar.nextDate(
                    after: anchor,
                    matching: target,
                    matchingPolicy: .nextTime,
                    repeatedTimePolicy: .last
                ))
            }
            guard let nextDay = calendar.date(byAdding: .day, value: 1, to: dayStart) else { break }
            dayStart = nextDay
        }

        var transitionCursor = start
        while let transition = timeZone.nextDaylightSavingTimeTransition(after: transitionCursor),
              transition < end {
            insertIfInside(transition)
            transitionCursor = transition
        }

        return instants.sorted().map { Date(timeIntervalSince1970: $0) }
    }

    private static func resolvePeriod(
        resolver: RatePeriodResolver,
        at instant: Date
    ) -> ResolvedPeriod? {
        guard let match = resolver.scheduleMatch(at: instant) else { return nil }
        let buyRate = match.window.buyRate
        let sellRate = match.window.sellRate
        guard buyRate.isFinite, sellRate.isFinite else { return nil }
        let name = match.window.touName.rawValue
        return ResolvedPeriod(
            identity: match.windowIdentity,
            periodKey: NextCheaperPeriod.periodKey(name),
            name: name,
            buyRate: buyRate,
            sellRate: sellRate
        )
    }
}
