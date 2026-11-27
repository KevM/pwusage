#if canImport(FoundationEssentials)
    import FoundationEssentials
#else
    import Foundation
#endif

/// DST-aware site time zone that wraps `TimeZone` on Apple platforms and runs purely on
/// host-resolved IANA transition tables on Wasm (`FoundationEssentials`, without ICU).
public struct SiteTimeZone: Equatable, Sendable {
    public struct Transition: Codable, Equatable, Sendable {
        /// UTC epoch seconds at which `offsetSeconds` takes effect.
        public let atEpochSeconds: Int64
        public let offsetSeconds: Int

        public init(atEpochSeconds: Int64, offsetSeconds: Int) {
            self.atEpochSeconds = atEpochSeconds
            self.offsetSeconds = offsetSeconds
        }
    }

    public let identifier: String
    public let initialOffsetSeconds: Int
    public let transitions: [Transition]
    private let nativeTimeZone: TimeZone?

    public init(_ timeZone: TimeZone) {
        identifier = timeZone.identifier
        initialOffsetSeconds = timeZone.secondsFromGMT()
        transitions = []
        nativeTimeZone = timeZone
    }

    public init(identifier: String, initialOffsetSeconds: Int, transitions: [Transition] = []) {
        self.identifier = identifier
        self.initialOffsetSeconds = initialOffsetSeconds
        self.transitions = transitions.sorted { $0.atEpochSeconds < $1.atEpochSeconds }
        nativeTimeZone = nil
    }

    public static let gmt = SiteTimeZone(identifier: "GMT", initialOffsetSeconds: 0)

    public func offsetSeconds(at date: Date) -> Int {
        if let nativeTimeZone {
            return nativeTimeZone.secondsFromGMT(for: date)
        }
        return offsetSeconds(atEpochSeconds: Self.floorSeconds(date))
    }

    public func nextTransition(after date: Date) -> Date? {
        if let nativeTimeZone {
            return nativeTimeZone.nextDaylightSavingTimeTransition(after: date)
        }
        let target = date.timeIntervalSince1970
        for transition in transitions where Double(transition.atEpochSeconds) > target {
            return Date(timeIntervalSince1970: Double(transition.atEpochSeconds))
        }
        return nil
    }

    public func localDayString(for date: Date) -> String {
        if let nativeTimeZone {
            let parts = Self.calendar(nativeTimeZone).dateComponents([.year, .month, .day], from: date)
            return Self.formatDay(year: parts.year ?? 0, month: parts.month ?? 0, day: parts.day ?? 0)
        }
        let civil = Self.civilFromDays(localDayIndex(for: date))
        return Self.formatDay(year: civil.year, month: civil.month, day: civil.day)
    }

    public func localHour(for date: Date) -> Int {
        localHourAndMinute(for: date).hour
    }

    public func localHourAndMinute(for date: Date) -> (hour: Int, minute: Int) {
        if let nativeTimeZone {
            let parts = Self.calendar(nativeTimeZone).dateComponents([.hour, .minute], from: date)
            return (parts.hour ?? 0, parts.minute ?? 0)
        }
        let epoch = Self.floorSeconds(date)
        let local = epoch + Int64(offsetSeconds(atEpochSeconds: epoch))
        let secondOfDay = Int(local - Self.floorDiv(local, 86_400) * 86_400)
        return (secondOfDay / 3600, (secondOfDay % 3600) / 60)
    }

    public func startOfDay(for date: Date) -> Date {
        if let nativeTimeZone {
            return Self.calendar(nativeTimeZone).startOfDay(for: date)
        }
        return utcStartOfLocalDay(localDayIndex(for: date))
    }

    public func startOfDay(addingDays days: Int, to date: Date) -> Date {
        if let nativeTimeZone {
            let calendar = Self.calendar(nativeTimeZone)
            let start = calendar.startOfDay(for: date)
            guard let shifted = calendar.date(byAdding: .day, value: days, to: start) else { return start }
            return calendar.startOfDay(for: shifted)
        }
        return utcStartOfLocalDay(localDayIndex(for: date) + Int64(days))
    }

    public func calendarDays(from start: Date, to end: Date) -> Int {
        if let nativeTimeZone {
            let calendar = Self.calendar(nativeTimeZone)
            let fromParts = calendar.dateComponents([.year, .month, .day], from: start)
            let toParts = calendar.dateComponents([.year, .month, .day], from: end)
            let fromDay = Self.daysFromCivil(
                year: fromParts.year ?? 1970, month: fromParts.month ?? 1, day: fromParts.day ?? 1)
            let toDay = Self.daysFromCivil(
                year: toParts.year ?? 1970, month: toParts.month ?? 1, day: toParts.day ?? 1)
            return Int(toDay - fromDay)
        }
        return Int(localDayIndex(for: end) - localDayIndex(for: start))
    }

    private func localDayIndex(for date: Date) -> Int64 {
        let epoch = Self.floorSeconds(date)
        let local = epoch + Int64(offsetSeconds(atEpochSeconds: epoch))
        return Self.floorDiv(local, 86_400)
    }

    private func offsetSeconds(atEpochSeconds epoch: Int64) -> Int {
        var low = 0
        var high = transitions.count
        while low < high {
            let mid = (low + high) / 2
            if transitions[mid].atEpochSeconds <= epoch {
                low = mid + 1
            } else {
                high = mid
            }
        }
        return low == 0 ? initialOffsetSeconds : transitions[low - 1].offsetSeconds
    }

    private func utcStartOfLocalDay(_ dayIndex: Int64) -> Date {
        let localMidnight = dayIndex * 86_400
        let guessOffset = offsetSeconds(atEpochSeconds: localMidnight - Int64(initialOffsetSeconds))
        let utcGuess = localMidnight - Int64(guessOffset)
        let resolvedOffset = offsetSeconds(atEpochSeconds: utcGuess)
        let candidateUtc = localMidnight - Int64(resolvedOffset)
        let verifyOffset = offsetSeconds(atEpochSeconds: candidateUtc)
        if verifyOffset == resolvedOffset {
            // If midnight falls in a fall-back overlap, prefer the first occurrence (earlier UTC).
            for (index, transition) in transitions.enumerated() where
                transition.atEpochSeconds <= candidateUtc && candidateUtc - transition.atEpochSeconds < 14_400 {
                let beforeOffset = index == 0 ? initialOffsetSeconds : transitions[index - 1].offsetSeconds
                if beforeOffset > verifyOffset {
                    let earlierUtc = localMidnight - Int64(beforeOffset)
                    if earlierUtc < transition.atEpochSeconds,
                       offsetSeconds(atEpochSeconds: earlierUtc) == beforeOffset {
                        return Date(timeIntervalSince1970: Double(earlierUtc))
                    }
                }
            }
            return Date(timeIntervalSince1970: Double(candidateUtc))
        }
        // Spring-forward gap across midnight: local day begins at the transition instant itself.
        let lowerBound = min(utcGuess, candidateUtc) - 14_400
        let upperBound = max(utcGuess, candidateUtc) + 14_400
        for transition in transitions where
            transition.atEpochSeconds >= lowerBound && transition.atEpochSeconds <= upperBound {
            let localAtTransition = transition.atEpochSeconds + Int64(transition.offsetSeconds)
            if Self.floorDiv(localAtTransition, 86_400) == dayIndex {
                return Date(timeIntervalSince1970: Double(transition.atEpochSeconds))
            }
        }
        return Date(timeIntervalSince1970: Double(candidateUtc))
    }

    private struct CivilDate {
        let year: Int
        let month: Int
        let day: Int
    }

    private static func calendar(_ timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    private static func floorSeconds(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970.rounded(.down))
    }

    private static func floorDiv(_ value: Int64, _ divisor: Int64) -> Int64 {
        let quotient = value / divisor
        let remainder = value % divisor
        return remainder < 0 ? quotient - 1 : quotient
    }

    private static func daysFromCivil(year: Int, month: Int, day: Int) -> Int64 {
        let adjustedYear = Int64(year) - (month <= 2 ? 1 : 0)
        let era = (adjustedYear >= 0 ? adjustedYear : adjustedYear - 399) / 400
        let yearOfEra = adjustedYear - era * 400
        let shiftedMonth = Int64(month) + (month > 2 ? -3 : 9)
        let dayOfYear = (153 * shiftedMonth + 2) / 5 + Int64(day) - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    private static func civilFromDays(_ daysSinceEpoch: Int64) -> CivilDate {
        let shifted = daysSinceEpoch + 719_468
        let era = (shifted >= 0 ? shifted : shifted - 146_096) / 146_097
        let dayOfEra = shifted - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        let year = yearOfEra + era * 400
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let monthPart = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * monthPart + 2) / 5 + 1
        let month = monthPart + (monthPart < 10 ? 3 : -9)
        return CivilDate(year: Int(year + (month <= 2 ? 1 : 0)), month: Int(month), day: Int(day))
    }

    private static func formatDay(year: Int, month: Int, day: Int) -> String {
        let rawYear = String(year)
        let yearText = rawYear.count < 4 ? String(repeating: "0", count: 4 - rawYear.count) + rawYear : rawYear
        let monthText = month < 10 ? "0\(month)" : "\(month)"
        let dayText = day < 10 ? "0\(day)" : "\(day)"
        return "\(yearText)-\(monthText)-\(dayText)"
    }
}
