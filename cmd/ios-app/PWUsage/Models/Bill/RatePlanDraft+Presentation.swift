import PWUsageCore

extension RatePlanDraft {
    var validationMessage: String? { validationIssue()?.message }
    var nameProblem: String? { nameIssue?.message }
}

extension RatePlanDraft.ValidationIssue {
    var message: String {
        switch self {
        case .missingName: "Name this rate plan."
        case .duplicateName(let name): "Another rate plan is already named \"\(name)\". Choose a different name."
        case .missingStartDate: "Choose a start date."
        case .missingEndDate: "Choose an end date, or choose Ongoing."
        case .startTooFarInFuture: "Effective start date can be at most a year from today."
        case .endBeforeStart: "Effective end date must be on or after the start date."
        case .missingSeasons: "Add at least one season."
        case .invalidSeasonMonths: "Invalid season months."
        case .incompleteYearCoverage: "Seasons must cover all 12 calendar months without gaps or overlaps."
        case .missingSeasonName: "Every season needs a name."
        case .schedule(let season, let isWeekday, let issue):
            "\(season) \(isWeekday ? "weekdays" : "weekends") \(issue.message)"
        case .invalidBuyRate(let season): "\(season): enter a valid Buy rate (0 to $10.00, up to 5 decimal places)."
        case .invalidSellRate(let season): "\(season): enter a valid Sell rate (0 to $10.00, up to 5 decimal places)."
        }
    }
}

extension SeasonDraft.ScheduleIssue {
    var message: String {
        switch self {
        case .missingPeriods: "needs at least one rate period."
        case .zeroLengthPeriod: "contains a zero-length rate period."
        case .incompleteDayCoverage: "must cover all 24 hours without gaps or overlaps."
        }
    }
}

extension DayPeriodDraft {
    var formattedTimeRange: String {
        if isAllDay { return "12:00 AM – 12:00 AM" }
        let startText = RatePlanTimelineFormatting.slotTimeLabel(startSlot)
        let endText = RatePlanTimelineFormatting.slotTimeLabel(endSlot)
        return "\(startText) – \(endText)"
    }
}
