import Foundation

/// A calendar month on the timeline, used to order solar health baselines and windows.
struct SolarHealthMonthStamp: Comparable, Hashable, Sendable {
    let year: Int
    let month: Int

    init(year: Int, month: Int) {
        self.year = year
        self.month = month
    }

    init(_ date: Date, calendar: Calendar) {
        let components = calendar.dateComponents([.year, .month], from: date)
        year = components.year ?? 0
        month = components.month ?? 1
    }

    var index: Int { year * 12 + month - 1 }

    func adding(months: Int) -> SolarHealthMonthStamp {
        let total = index + months
        let newYear = total >= 0 ? total / 12 : (total - 11) / 12
        let newMonth = total - newYear * 12 + 1
        return SolarHealthMonthStamp(year: newYear, month: newMonth)
    }

    static func < (lhs: SolarHealthMonthStamp, rhs: SolarHealthMonthStamp) -> Bool {
        lhs.index < rhs.index
    }
}

extension Calendar {
    /// Gregorian in the device's time zone: the pass stamps months by Gregorian year, whatever
    /// calendar the user prefers, so install dates and `now` must be stamped the same way.
    static var gregorianStamps: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        return calendar
    }
}

/// Site-wide and per-month clear-day baseline learned from a site's earliest post-install months.
struct SolarHealthBaseline: Equatable, Sendable {
    enum Label: Equatable, Sendable {
        case asNew
        case firstYear(Int)
    }

    struct Month: Equatable, Sendable {
        let stamp: SolarHealthMonthStamp
        let capacity: SolarHealthCapacity
    }

    static let windowMonths = 12
    static let minFrozenSeasons = 3
    static let olderSystemGapMonths = 13

    let windowStart: SolarHealthMonthStamp
    /// Calendar month (1...12) -> its first monthly capacity on or after `windowStart`, even after the window.
    let months: [Int: Month]
    /// Mean of the window months' site factors: clear-day weighted when frozen, equal weights while provisional.
    let siteFactor: Double
    /// Site-wide baseline per face, same weighting, over window months where the fit separated the faces.
    let directionFactors: [SolarHealthCapacity.Direction]
    /// Distinct seasons among all calendar-month baselines.
    let seasonsCovered: Int
    /// Clear days behind the window months.
    let clearDays: Int
    let isProvisional: Bool
    let label: Label
    /// Year of the newest system when history before it exists and there is more than one system.
    let restartYear: Int?
    /// `reference.directions.count`: a month separated the faces when its directions count matches.
    let faceCount: Int

    init?(
        years: [SolarHealthYear],
        reference: SolarHealthReference,
        manual: ManualSolarLayout,
        now: Date,
        calendar: Calendar = .gregorianStamps
    ) {
        let factorMonths = Self.sortedFactorMonths(from: years)
        let latestInstall = manual.systems.compactMap(\.installDate).max()
            .map { SolarHealthMonthStamp($0, calendar: calendar) }
        guard let firstPostInstall = Self.firstMonth(in: factorMonths, onOrAfter: latestInstall) else {
            return nil
        }

        let start = latestInstall.map { max($0, firstPostInstall.stamp) } ?? firstPostInstall.stamp
        let windowEnd = start.adding(months: Self.windowMonths)
        let baselineMonths = Self.firstCalendarMonths(in: factorMonths, from: start)
        let inWindow = baselineMonths.values.filter { $0.stamp < windowEnd }
        guard !inWindow.isEmpty else { return nil }

        let seasons = Set(baselineMonths.keys.map { SolarSeason.of(month: $0, latitude: 0) }).count
        let provisional = SolarHealthMonthStamp(now, calendar: calendar) < windowEnd
            || seasons < Self.minFrozenSeasons
        let faces = reference.directions.count

        windowStart = start
        months = baselineMonths
        siteFactor = Self.weightedSiteFactor(inWindow, provisional: provisional)
        directionFactors = Self.weightedDirectionFactors(
            inWindow,
            directions: reference.directions,
            faceCount: faces,
            provisional: provisional)
        seasonsCovered = seasons
        clearDays = inWindow.reduce(0) { $0 + $1.capacity.clearDays }
        isProvisional = provisional
        label = Self.makeLabel(latestInstall: latestInstall, firstFactor: firstPostInstall.stamp, start: start)
        restartYear = Self.makeRestartYear(
            systemCount: manual.systems.count,
            latestInstall: latestInstall,
            earliestFactor: factorMonths.first?.stamp)
        faceCount = faces
    }

    func monthFactor(_ month: Int) -> Double {
        months[month]?.capacity.site ?? siteFactor
    }

    func directionFactor(azimuth: Double) -> Double {
        directionFactors.first { Self.azimuthMatches($0.azimuth, azimuth) }?.factor ?? siteFactor
    }

    func isBeforeWindow(_ stamp: SolarHealthMonthStamp) -> Bool {
        stamp < windowStart
    }

    func isBeforeWindow(year: Int) -> Bool {
        year < windowStart.year
    }

    /// "of new" or "of 2022", for "98% of new".
    var relativeUnit: String {
        switch label {
        case .asNew: "of new"
        case let .firstYear(year): "of \(year)"
        }
    }

    static func sortedFactorMonths(from years: [SolarHealthYear]) -> [Month] {
        years.flatMap { year in
            year.months.compactMap { month -> Month? in
                guard month.capacity.site > 0 else { return nil }
                return Month(
                    stamp: SolarHealthMonthStamp(year: year.year, month: month.month),
                    capacity: month.capacity)
            }
        }
        .sorted { $0.stamp < $1.stamp }
    }

    private static func firstMonth(
        in factorMonths: [Month],
        onOrAfter limit: SolarHealthMonthStamp?
    ) -> Month? {
        guard let limit else { return factorMonths.first }
        return factorMonths.first { $0.stamp >= limit }
    }

    private static func firstCalendarMonths(
        in factorMonths: [Month],
        from start: SolarHealthMonthStamp
    ) -> [Int: Month] {
        var result: [Int: Month] = [:]
        for entry in factorMonths where entry.stamp >= start && result[entry.stamp.month] == nil {
            result[entry.stamp.month] = entry
        }
        return result
    }

    private static func weight(for month: Month, provisional: Bool) -> Double {
        provisional ? 1 : Double(month.capacity.clearDays)
    }

    private static func weightedSiteFactor(_ windowMonths: [Month], provisional: Bool) -> Double {
        let samples = windowMonths.map { (value: $0.capacity.site, weight: weight(for: $0, provisional: provisional)) }
        return weightedMean(of: samples) ?? 0
    }

    private static func weightedDirectionFactors(
        _ windowMonths: [Month],
        directions: [SolarHealthDirection],
        faceCount: Int,
        provisional: Bool
    ) -> [SolarHealthCapacity.Direction] {
        let separated = windowMonths.filter { $0.capacity.directions.count == faceCount }
        return directions.compactMap { direction in
            let samples = separated.compactMap { month -> (value: Double, weight: Double)? in
                guard let match = month.capacity.directions.first(where: {
                    azimuthMatches($0.azimuth, direction.azimuth)
                }) else {
                    return nil
                }
                return (match.factor, weight(for: month, provisional: provisional))
            }
            guard let mean = weightedMean(of: samples) else { return nil }
            return SolarHealthCapacity.Direction(azimuth: direction.azimuth, factor: mean)
        }
    }

    static func weightedMean(of samples: [(value: Double, weight: Double)]) -> Double? {
        guard !samples.isEmpty else { return nil }
        let totalWeight = samples.reduce(0.0) { $0 + $1.weight }
        guard totalWeight > 0 else {
            return samples.reduce(0.0) { $0 + $1.value } / Double(samples.count)
        }
        return samples.reduce(0.0) { $0 + $1.value * $1.weight } / totalWeight
    }

    private static func makeLabel(
        latestInstall: SolarHealthMonthStamp?,
        firstFactor: SolarHealthMonthStamp,
        start: SolarHealthMonthStamp
    ) -> Label {
        guard let latestInstall,
              firstFactor.index - latestInstall.index > olderSystemGapMonths
        else {
            return .asNew
        }
        return .firstYear(start.year)
    }

    private static func makeRestartYear(
        systemCount: Int,
        latestInstall: SolarHealthMonthStamp?,
        earliestFactor: SolarHealthMonthStamp?
    ) -> Int? {
        guard systemCount > 1,
              let latestInstall,
              let earliestFactor,
              earliestFactor < latestInstall
        else {
            return nil
        }
        return latestInstall.year
    }

    static func azimuthMatches(_ lhs: Double, _ rhs: Double) -> Bool {
        let delta = abs(LayoutFit.wrapDegrees(lhs - rhs + 180) - 180)
        return delta < 0.5
    }
}
