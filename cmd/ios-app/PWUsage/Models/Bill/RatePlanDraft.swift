import Foundation

struct RatePlanDraft: Equatable, Sendable {
    var name: String
    var effectiveFrom: Date
    var isOngoing: Bool
    var effectiveTo: Date
    var timeZone: TimeZone
    var seasons: [SeasonDraft]

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
            name: "Season \(seasons.count + 1)",
            fromMonth: splitStart,
            toMonth: originalEnd
        )
        newSeason.weekdayWindows = seasons[longestIndex].weekdayWindows
        newSeason.weekendWindows = seasons[longestIndex].weekendWindows
        newSeason.sameScheduleAsWeekdays = seasons[longestIndex].sameScheduleAsWeekdays
        seasons.insert(newSeason, at: longestIndex + 1)
    }

    mutating func removeSeason(at index: Int) {
        guard seasons.count > 1, seasons.indices.contains(index) else { return }
        let removed = seasons.remove(at: index)
        if index > 0 {
            seasons[index - 1].toMonth = removed.toMonth
        } else {
            seasons[0].fromMonth = removed.fromMonth
        }
    }

    mutating func moveSeasonBoundary(afterIndex index: Int, toStartMonth candidateMonth: Int) {
        guard seasons.count >= 2, seasons.indices.contains(index) else { return }
        let nextIndex = (index + 1) % seasons.count
        let clampedStart = ((candidateMonth - 1) % 12 + 12) % 12 + 1
        var first = seasons[index]
        var second = seasons[nextIndex]
        first.toMonth = wrapMonth(clampedStart - 1)
        second.fromMonth = clampedStart
        guard monthSpan(first) >= 1, monthSpan(second) >= 1 else { return }
        seasons[index] = first
        seasons[nextIndex] = second
    }

    func validate(today: Date = .now) -> String? {
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
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Utility Rate Plan" : trimmed
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
