import Foundation

struct DayPeriodDraft: Identifiable, Equatable, Hashable, Sendable {
    let id: UUID
    var touName: TariffPeriodName
    var startSlot: Int
    var endSlot: Int
    var buyRateText: String
    var sellRateText: String

    init(
        id: UUID = UUID(),
        touName: TariffPeriodName,
        startSlot: Int,
        endSlot: Int,
        buyRateText: String,
        sellRateText: String
    ) {
        self.id = id
        self.touName = touName
        self.startSlot = startSlot
        self.endSlot = endSlot
        self.buyRateText = buyRateText
        self.sellRateText = sellRateText
    }

    init(from window: TimePeriodWindowInput) {
        let start = max(0, min(47, window.fromHour * 2 + (window.fromMinute >= 30 ? 1 : 0)))
        let rawEnd = window.toHour == 24 ? 48 : max(0, min(47, window.toHour * 2 + (window.toMinute >= 30 ? 1 : 0)))
        id = UUID()
        touName = window.touName
        startSlot = start
        endSlot = rawEnd
        buyRateText = Self.formatInputNumber(window.buyRate)
        sellRateText = Self.formatInputNumber(window.sellRate)
    }

    var isAllDay: Bool {
        startSlot == 0 && (endSlot == 48 || endSlot == 0)
    }

    var slotDuration: Int {
        if isAllDay { return 48 }
        if endSlot > startSlot { return endSlot - startSlot }
        if endSlot < startSlot { return (48 - startSlot) + endSlot }
        return 0
    }

    var formattedTimeRange: String {
        if isAllDay { return "12:00 AM – 12:00 AM" }
        let startText = RatePlanTimelineFormatting.slotTimeLabel(startSlot)
        let endText = RatePlanTimelineFormatting.slotTimeLabel(endSlot)
        return "\(startText) – \(endText)"
    }

    func toInput() -> TimePeriodWindowInput? {
        guard case .success(let buy) = RateFormatting.parseRate(buyRateText),
              case .success(let sell) = RateFormatting.parseRate(sellRateText) else {
            return nil
        }
        let fromHour = startSlot / 2
        let fromMinute = (startSlot % 2) * 30
        let normalizedEnd = endSlot == 48 ? 24 : endSlot / 2
        let endMinute = endSlot == 48 ? 0 : (endSlot % 2) * 30
        return TimePeriodWindowInput(
            touName: touName,
            fromHour: fromHour,
            fromMinute: fromMinute,
            toHour: normalizedEnd,
            toMinute: endMinute,
            buyRate: buy,
            sellRate: sell
        )
    }

    private static func formatInputNumber(_ value: Double) -> String {
        let rounded = (value * 100_000).rounded() / 100_000
        let formatted = String(format: "%.5f", rounded)
        var trimmed = formatted
        while trimmed.contains("."), trimmed.hasSuffix("0") {
            let withoutLast = String(trimmed.dropLast())
            if let dot = withoutLast.firstIndex(of: "."),
               withoutLast.distance(from: dot, to: withoutLast.endIndex) <= 3 {
                trimmed = withoutLast
                break
            }
            trimmed = withoutLast
        }
        return trimmed
    }
}

struct SeasonDraft: Identifiable, Equatable, Hashable, Sendable {
    let id: UUID
    var name: String
    var fromMonth: Int
    var toMonth: Int
    var weekdayWindows: [DayPeriodDraft]
    var weekendWindows: [DayPeriodDraft]
    var sameScheduleAsWeekdays: Bool

    static func makeDefault(name: String, fromMonth: Int, toMonth: Int) -> SeasonDraft {
        let offPeak = DayPeriodDraft(
            touName: .offPeak,
            startSlot: 0,
            endSlot: 48,
            buyRateText: "0.10",
            sellRateText: "0.03"
        )
        return SeasonDraft(
            id: UUID(),
            name: name,
            fromMonth: fromMonth,
            toMonth: toMonth,
            weekdayWindows: [offPeak],
            weekendWindows: [DayPeriodDraft(
                touName: .offPeak,
                startSlot: 0,
                endSlot: 48,
                buyRateText: "0.10",
                sellRateText: "0.03"
            )],
            sameScheduleAsWeekdays: true
        )
    }

    init(
        id: UUID = UUID(),
        name: String,
        fromMonth: Int,
        toMonth: Int,
        weekdayWindows: [DayPeriodDraft],
        weekendWindows: [DayPeriodDraft],
        sameScheduleAsWeekdays: Bool? = nil
    ) {
        self.id = id
        self.name = name
        self.fromMonth = fromMonth
        self.toMonth = toMonth
        self.weekdayWindows = weekdayWindows
        self.weekendWindows = weekendWindows
        self.sameScheduleAsWeekdays = sameScheduleAsWeekdays ?? Self.windowsMatch(weekdayWindows, weekendWindows)
    }

    init(from season: TariffSeasonInput) {
        let weekdays = season.weekdayPeriods.map(DayPeriodDraft.init(from:))
        let weekends = season.weekendPeriods.map(DayPeriodDraft.init(from:))
        self.init(
            name: season.name,
            fromMonth: season.fromMonth,
            toMonth: season.toMonth,
            weekdayWindows: weekdays,
            weekendWindows: weekends
        )
    }

    func validateWeekdaySlots() -> String? {
        Self.validateSlots(weekdayWindows, label: "\(name) weekdays")
    }

    func validateWeekendSlots() -> String? {
        let target = sameScheduleAsWeekdays ? weekdayWindows : weekendWindows
        return Self.validateSlots(target, label: "\(name) weekends")
    }

    func validateRates() -> String? {
        let all = weekdayWindows + (sameScheduleAsWeekdays ? [] : weekendWindows)
        for window in all {
            if case .failure = RateFormatting.parseRate(window.buyRateText) {
                return "\(name): enter a valid Buy rate (0 to $10.00, up to 5 decimal places)."
            }
            if case .failure = RateFormatting.parseRate(window.sellRateText) {
                return "\(name): enter a valid Sell rate (0 to $10.00, up to 5 decimal places)."
            }
        }
        return nil
    }

    mutating func addTimePeriod(isWeekday: Bool) {
        var list = isWeekday ? weekdayWindows : weekendWindows
        guard let longestIndex = list.indices.max(by: { list[$0].slotDuration < list[$1].slotDuration }),
              list[longestIndex].slotDuration >= 2 else {
            return
        }
        let target = list[longestIndex]
        let splitOffset = target.slotDuration / 2
        let splitSlot = (target.startSlot + splitOffset) % 48
        let originalEnd = target.endSlot == 48 && target.startSlot != 0 ? 48 : target.endSlot
        let nextType: TariffPeriodName = list.contains(where: { $0.touName == .onPeak }) ? .partialPeak : .onPeak
        list[longestIndex].endSlot = splitSlot
        let newWindow = DayPeriodDraft(
            touName: nextType,
            startSlot: splitSlot,
            endSlot: target.isAllDay ? 48 : originalEnd,
            buyRateText: target.buyRateText,
            sellRateText: target.sellRateText
        )
        list.insert(newWindow, at: longestIndex + 1)
        assignWindows(list, isWeekday: isWeekday)
    }

    mutating func removeTimePeriod(at index: Int, isWeekday: Bool) {
        var list = isWeekday ? weekdayWindows : weekendWindows
        guard list.count > 1, list.indices.contains(index) else { return }
        let removed = list.remove(at: index)
        if index > 0 {
            list[index - 1].endSlot = removed.endSlot
        } else {
            list[0].startSlot = removed.startSlot
        }
        if list.count == 1 {
            list[0].startSlot = 0
            list[0].endSlot = 48
        }
        assignWindows(list, isWeekday: isWeekday)
    }

    mutating func movePeriodBoundary(afterIndex index: Int, toSlot candidateSlot: Int, isWeekday: Bool) {
        var list = isWeekday ? weekdayWindows : weekendWindows
        guard list.count >= 2, list.indices.contains(index) else { return }
        let nextIndex = (index + 1) % list.count
        // Keep the boundary inside the two adjacent windows' combined span so it can never
        // cross a neighbouring boundary and wrap into an overlapping schedule.
        let spanStart = list[index].startSlot % 48
        var span = ((list[nextIndex].endSlot - spanStart) % 48 + 48) % 48
        if span == 0 { span = 48 }
        guard span >= 2 else { return }
        let candidate = ((max(0, min(47, candidateSlot)) - spanStart) % 48 + 48) % 48
        var offset = candidate
        if candidate == 0 {
            offset = 1
        } else if candidate > span - 1 {
            offset = candidate - span <= 48 - candidate ? span - 1 : 1
        }
        let snapped = (spanStart + offset) % 48
        var updatedFirst = list[index]
        var updatedSecond = list[nextIndex]
        updatedFirst.endSlot = snapped
        updatedSecond.startSlot = snapped
        guard updatedFirst.slotDuration >= 1, updatedSecond.slotDuration >= 1 else { return }
        list[index] = updatedFirst
        list[nextIndex] = updatedSecond
        assignWindows(list, isWeekday: isWeekday)
    }

    func toInput() -> TariffSeasonInput? {
        guard validateWeekdaySlots() == nil, validateWeekendSlots() == nil, validateRates() == nil else {
            return nil
        }
        let weekdays = weekdayWindows.compactMap { $0.toInput() }
        let weekends = (sameScheduleAsWeekdays ? weekdayWindows : weekendWindows).compactMap { $0.toInput() }
        guard weekdays.count == weekdayWindows.count else { return nil }
        return TariffSeasonInput(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            fromMonth: fromMonth,
            toMonth: toMonth,
            weekdayPeriods: weekdays,
            weekendPeriods: weekends
        )
    }

    private mutating func assignWindows(_ list: [DayPeriodDraft], isWeekday: Bool) {
        if isWeekday {
            weekdayWindows = list
            if sameScheduleAsWeekdays { weekendWindows = list }
        } else {
            sameScheduleAsWeekdays = false
            weekendWindows = list
        }
    }

    private static func validateSlots(_ windows: [DayPeriodDraft], label: String) -> String? {
        guard !windows.isEmpty else { return "\(label) needs at least one rate period." }
        var coverage = [Int](repeating: 0, count: 48)
        for window in windows {
            guard window.slotDuration >= 1 else {
                return "\(label) contains a zero-length rate period."
            }
            if window.isAllDay {
                for slot in 0 ..< 48 { coverage[slot] += 1 }
            } else if window.startSlot < window.endSlot {
                for slot in window.startSlot ..< window.endSlot { coverage[slot] += 1 }
            } else {
                for slot in window.startSlot ..< 48 { coverage[slot] += 1 }
                for slot in 0 ..< window.endSlot { coverage[slot] += 1 }
            }
        }
        guard coverage.allSatisfy({ $0 == 1 }) else {
            return "\(label) must cover all 24 hours without gaps or overlaps."
        }
        return nil
    }

    private static func windowsMatch(_ lhs: [DayPeriodDraft], _ rhs: [DayPeriodDraft]) -> Bool {
        guard lhs.count == rhs.count else { return false }
        return zip(lhs, rhs).allSatisfy { left, right in
            left.touName == right.touName && left.startSlot == right.startSlot
                && left.endSlot == right.endSlot && left.buyRateText == right.buyRateText
                && left.sellRateText == right.sellRateText
        }
    }
}
