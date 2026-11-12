import Foundation

struct RatePlanDraft: Equatable, Sendable {
    var name: String
    var effectiveFrom: Date
    var isOngoing: Bool
    var effectiveTo: Date
    var timeZone: TimeZone
    var seasons: [SeasonDraft]
    /// Names of the site's other rate plans; a plan's name must be new.
    var takenNames: [String] = []

    static func makeBlank(timeZone: TimeZone) -> RatePlanDraft {
        let today = startOfToday(in: timeZone)
        return RatePlanDraft(
            name: "",
            effectiveFrom: today,
            isOngoing: true,
            effectiveTo: today,
            timeZone: timeZone,
            seasons: [SeasonDraft.makeDefault(name: "All year", fromMonth: 1, toMonth: 12)]
        )
    }

    init(
        name: String,
        effectiveFrom: Date,
        isOngoing: Bool,
        effectiveTo: Date,
        timeZone: TimeZone,
        seasons: [SeasonDraft]
    ) {
        self.name = name
        self.effectiveFrom = effectiveFrom
        self.isOngoing = isOngoing
        self.effectiveTo = effectiveTo
        self.timeZone = timeZone
        self.seasons = seasons
    }

    init(copyingFrom period: TariffPeriodDTO, timeZone: TimeZone) {
        let today = Self.startOfToday(in: timeZone)
        let seasons = period.seasons.isEmpty
            ? [SeasonDraft.makeDefault(name: "All year", fromMonth: 1, toMonth: 12)]
            : period.seasons.map(SeasonDraft.init(from:))
        self.init(
            name: period.name,
            effectiveFrom: today,
            isOngoing: true,
            effectiveTo: today,
            timeZone: timeZone,
            seasons: seasons
        )
    }

    init(editing period: TariffPeriodDTO, timeZone: TimeZone) {
        let today = Self.startOfToday(in: timeZone)
        let from = RatePlanTimelineFormatting.parseYMD(period.effectiveFrom, in: timeZone) ?? today
        let toDate = period.effectiveTo.flatMap {
            RatePlanTimelineFormatting.parseYMD($0, in: timeZone)
        } ?? today
        let seasons = period.seasons.isEmpty
            ? [SeasonDraft.makeDefault(name: "All year", fromMonth: 1, toMonth: 12)]
            : period.seasons.map(SeasonDraft.init(from:))
        self.init(
            name: period.name,
            effectiveFrom: from,
            isOngoing: period.effectiveTo == nil,
            effectiveTo: toDate,
            timeZone: timeZone,
            seasons: seasons
        )
    }

    mutating func addSeason() {
        guard seasons.count < 6,
              let longestIndex = seasons.indices.max(by: {
                  monthSpan(seasons[$0]) < monthSpan(seasons[$1])
              }) else {
            return
        }
        let span = monthSpan(seasons[longestIndex])
        guard span >= 2 else { return }
        let firstCount = span / 2
        let splitStart = wrapMonth(seasons[longestIndex].fromMonth + firstCount)
        let originalEnd = seasons[longestIndex].toMonth
        seasons[longestIndex].toMonth = wrapMonth(splitStart - 1)
        var newSeason = SeasonDraft.makeDefault(
            name: "Season",
            fromMonth: splitStart,
            toMonth: originalEnd
        )
        newSeason.copySchedule(from: seasons[longestIndex])
        seasons.insert(newSeason, at: longestIndex + 1)
        relabelGenericSeasonNames()
    }

    mutating func removeSeason(at index: Int) {
        guard seasons.count > 1, seasons.indices.contains(index) else { return }
        let removed = seasons.remove(at: index)
        if index > 0 {
            seasons[index - 1].toMonth = removed.toMonth
        } else {
            seasons[0].fromMonth = removed.fromMonth
        }
        relabelGenericSeasonNames()
    }

    mutating func moveSeasonBoundary(afterIndex index: Int, toStartMonth candidateMonth: Int) {
        guard seasons.count >= 2, seasons.indices.contains(index) else { return }
        let nextIndex = (index + 1) % seasons.count
        var first = seasons[index]
        var second = seasons[nextIndex]
        // Keep the new start inside the two adjacent seasons' combined span: inverted months
        // count as a year-wrapping season, so an unchecked move can overlap a third season.
        let combined = ((second.toMonth - first.fromMonth) % 12 + 12) % 12 + 1
        guard combined >= 2 else { return }
        let offset = ((candidateMonth - first.fromMonth) % 12 + 12) % 12
        var clampedOffset = offset
        if offset == 0 {
            clampedOffset = 1
        } else if offset > combined - 1 {
            clampedOffset = offset - (combined - 1) <= 12 - offset ? combined - 1 : 1
        }
        let clampedStart = wrapMonth(first.fromMonth + clampedOffset)
        first.toMonth = wrapMonth(clampedStart - 1)
        second.fromMonth = clampedStart
        guard monthSpan(first) >= 1, monthSpan(second) >= 1 else { return }
        seasons[index] = first
        seasons[nextIndex] = second
        relabelGenericSeasonNames()
    }

    // MARK: Automatic season names

    private static let seasonNameStems = ["All year", "Summer", "Winter", "Spring", "Fall", "Season"]

    /// Names the app made up (or the user left at a stock label), as opposed to ones they typed.
    static func isGenericSeasonName(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return seasonNameStems.contains { stem in
            trimmed.caseInsensitiveCompare(stem) == .orderedSame
                || (trimmed.lowercased().hasPrefix(stem.lowercased() + " ")
                    && Int(trimmed.dropFirst(stem.count + 1)) != nil)
        }
    }

    /// Northern-hemisphere guess: Jun–Sep is Summer (the usual time-of-use summer), Oct–May Winter.
    /// With three or more seasons the middle month picks Winter/Spring/Summer/Fall.
    static func suggestedSeasonName(fromMonth: Int, toMonth: Int, seasonCount: Int) -> String {
        let length = ((toMonth - fromMonth) % 12 + 12) % 12 + 1
        if seasonCount <= 1 || length == 12 { return "All year" }
        let months = (0 ..< length).map { (fromMonth - 1 + $0) % 12 + 1 }
        if seasonCount == 2 {
            let summerMonths = months.filter { (6 ... 9).contains($0) }.count
            return summerMonths * 2 >= length ? "Summer" : "Winter"
        }
        let middle = months[(length - 1) / 2]
        switch middle {
        case 12, 1, 2: return "Winter"
        case 3, 4, 5: return "Spring"
        case 6, 7, 8, 9: return "Summer"
        default: return "Fall"
        }
    }

    /// Re-derives names for seasons still carrying a generic label, keeping repeats distinct.
    private mutating func relabelGenericSeasonNames() {
        var used: [String: Int] = [:]
        for index in seasons.indices {
            guard Self.isGenericSeasonName(seasons[index].name) else {
                used[seasons[index].name, default: 0] += 1
                continue
            }
            let base = Self.suggestedSeasonName(
                fromMonth: seasons[index].fromMonth,
                toMonth: seasons[index].toMonth,
                seasonCount: seasons.count
            )
            let count = (used[base] ?? 0) + 1
            used[base] = count
            seasons[index].name = count == 1 ? base : "\(base) \(count)"
        }
    }

    func validate(today: Date = .now) -> String? {
        if let nameError = nameProblem { return nameError }
        if let dateError = validateDates(today: today) { return dateError }
        if let monthError = validateMonthCoverage() { return monthError }
        for season in seasons {
            if season.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return "Every season needs a name."
            }
            if let weekdayError = season.validateWeekdaySlots() { return weekdayError }
            if let weekendError = season.validateWeekendSlots() { return weekendError }
            if let rateError = season.validateRates() { return rateError }
        }
        return nil
    }

    func toWriteRequest() -> TariffPlanWriteRequest? {
        guard validate() == nil else { return nil }
        let compiledSeasons = seasons.compactMap { $0.toInput() }
        guard compiledSeasons.count == seasons.count else { return nil }
        let resolvedName = effectiveName
        let fromStr = RatePlanTimelineFormatting.formatYMD(effectiveFrom, in: timeZone)
        let toStr = isOngoing ? nil : RatePlanTimelineFormatting.formatYMD(effectiveTo, in: timeZone)
        return TariffPlanWriteRequest(
            name: resolvedName,
            effectiveFrom: fromStr,
            effectiveTo: toStr,
            seasons: compiledSeasons
        )
    }

    var effectiveName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Why the name can't be used yet, or nil when it can.
    var nameProblem: String? {
        if effectiveName.isEmpty { return "Name this rate plan." }
        let wanted = effectiveName.lowercased()
        if takenNames.contains(where: {
            $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == wanted
        }) {
            return "Another rate plan is already named \"\(effectiveName)\". Choose a different name."
        }
        return nil
    }

    private func validateDates(today: Date) -> String? {
        let fromStr = RatePlanTimelineFormatting.formatYMD(effectiveFrom, in: timeZone)
        let todayStr = RatePlanTimelineFormatting.formatYMD(today, in: timeZone)
        if fromStr > todayStr {
            return "Effective start date cannot be in the future."
        }
        if !isOngoing {
            let toStr = RatePlanTimelineFormatting.formatYMD(effectiveTo, in: timeZone)
            if toStr < fromStr {
                return "Effective end date must be on or after the start date."
            }
        }
        return nil
    }

    private func validateMonthCoverage() -> String? {
        guard !seasons.isEmpty else { return "Add at least one season." }
        var counts = [Int](repeating: 0, count: 12)
        for season in seasons {
            guard (1 ... 12).contains(season.fromMonth), (1 ... 12).contains(season.toMonth) else {
                return "Invalid season months."
            }
            var month = season.fromMonth
            for _ in 0 ..< 12 {
                counts[month - 1] += 1
                if month == season.toMonth { break }
                month = wrapMonth(month + 1)
            }
        }
        guard counts.allSatisfy({ $0 == 1 }) else {
            return "Seasons must cover all 12 calendar months without gaps or overlaps."
        }
        return nil
    }

    private func monthSpan(_ season: SeasonDraft) -> Int {
        if season.fromMonth <= season.toMonth {
            return season.toMonth - season.fromMonth + 1
        }
        return (12 - season.fromMonth + 1) + season.toMonth
    }

    private func wrapMonth(_ raw: Int) -> Int {
        ((raw - 1) % 12 + 12) % 12 + 1
    }

    private static func startOfToday(in timeZone: TimeZone) -> Date {
        let todayYMD = RatePlanTimelineFormatting.formatYMD(.now, in: timeZone)
        return RatePlanTimelineFormatting.parseYMD(todayYMD, in: timeZone) ?? .now
    }
}
