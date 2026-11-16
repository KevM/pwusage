import Foundation

/// Pure formatting helpers for Savings Phase 2 UI copy and fixed rate plan drafts.
enum SavingsPresentation {
    /// Whole-dollar currency string with `about`, e.g. `"about $142"`.
    static func aboutAmount(
        _ amount: Double,
        currency: String,
        locale: Locale = .current
    ) -> String {
        "about \(wholeCurrency(abs(amount), currency: currency, locale: locale))"
    }

    /// Headline for the current billing cycle card, e.g. `"Your system saved about $142 this cycle"`.
    static func cycleHeadline(
        _ figures: SavingsFigures,
        currency: String,
        locale: Locale = .current
    ) -> String {
        let verb = figures.total >= 0 ? "saved" : "cost"
        let amount = aboutAmount(figures.total, currency: currency, locale: locale)
        return "Your system \(verb) \(amount) this cycle"
    }

    /// Headline for multi-cycle periods (Past Year / Lifetime), e.g. `"Your system saved about $1,680"`.
    static func periodHeadline(
        _ figures: SavingsFigures,
        currency: String,
        locale: Locale = .current
    ) -> String {
        let verb = figures.total >= 0 ? "saved" : "cost"
        let amount = aboutAmount(figures.total, currency: currency, locale: locale)
        return "Your system \(verb) \(amount)"
    }

    /// Whole-dollar currency string with `about`, preserving negative signs (e.g. `"about -$40"`).
    static func signedAboutAmount(
        _ amount: Double,
        currency: String,
        locale: Locale = .current
    ) -> String {
        let rounded = amount.rounded()
        let normalized = rounded == 0 ? 0 : rounded
        return "about \(wholeCurrency(normalized, currency: currency, locale: locale))"
    }

    /// Breakdown line for solar and Powerwall + rate plan components.
    static func breakdownLine(
        _ figures: SavingsFigures,
        currency: String,
        locale: Locale = .current
    ) -> String {
        let solar = signedAboutAmount(figures.solar, currency: currency, locale: locale)
        let tou = signedAboutAmount(figures.powerwallAndRatePlan, currency: currency, locale: locale)
        return "Solar \(solar) · Powerwall and your rate plan \(tou)"
    }

    /// Fixed-rate comparison line showing what the system would have saved/cost on the fixed rate plan.
    static func fixedRateComparisonLine(
        _ figures: SavingsFigures,
        currency: String,
        locale: Locale = .current
    ) -> String {
        let verb = figures.fixedRateSystem >= 0 ? "saved" : "cost"
        let amount = aboutAmount(figures.fixedRateSystem, currency: currency, locale: locale)
        return "On a fixed rate plan, your system would have \(verb) \(amount)"
    }

    /// Day coverage disclosure line, e.g. `"Based on 2,914 of 2,950 days"`.
    static func coverageLine(
        _ figures: SavingsFigures,
        locale: Locale = .current
    ) -> String {
        let covered = figures.daysWithData.formatted(.number.locale(locale))
        let total = figures.daysInPeriod.formatted(.number.locale(locale))
        return "Based on \(covered) of \(total) days"
    }

    private static func wholeCurrency(
        _ value: Double,
        currency: String,
        locale: Locale
    ) -> String {
        value.rounded().formatted(
            .currency(code: currency)
                .locale(locale)
                .precision(.fractionLength(0))
        )
    }

    static func showsCard(_ figures: SavingsFigures) -> Bool {
        figures.daysWithData > 0 || !caveats(figures).isEmpty
    }

    static func caveats(_ figures: SavingsFigures) -> [SavingsCaveat] {
        var result: [SavingsCaveat] = []
        if let gap = figures.gap(.noFixedRatePlan) {
            let text: String
            let suggestedStart: String?
            if let start = gap.fixedRatePlanStart {
                text = "Your fixed rate plan starts \(RatePlanTimelineFormatting.displayDate(start)), "
                    + "so earlier days aren’t counted."
                suggestedStart = gap.ranges.first?.first
            } else {
                text = "We don’t have your fixed rate plan for \(dayRangesText(gap.ranges, days: gap.days)), "
                    + "so those days aren’t counted."
                suggestedStart = nil
            }
            result.append(SavingsCaveat(text: text, action: .editFixedRatePlan(suggestedStart: suggestedStart)))
        }
        if let gap = figures.gap(.noRatePlan) {
            let text = "We don’t have your rate plan for \(dayRangesText(gap.ranges, days: gap.days)), "
                + "so those days aren’t counted."
            result.append(SavingsCaveat(text: text, action: .fixRatePlans))
        }
        return result
    }

    static func dayRangesText(_ ranges: [SavingsDayRange], days: Int) -> String {
        guard let first = ranges.first, let last = ranges.last else { return "" }
        if ranges.count >= 3 {
            return "\(days) days between \(RatePlanTimelineFormatting.displayDate(first.first)) and "
                + RatePlanTimelineFormatting.displayDate(last.last)
        }
        return ranges.map(rangeText).joined(separator: " and ")
    }

    private static func rangeText(_ range: SavingsDayRange) -> String {
        let end = RatePlanTimelineFormatting.displayDate(range.last)
        guard range.first != range.last else { return end }
        let start: String
        if range.first.prefix(4) == range.last.prefix(4),
           let date = RatePlanTimelineFormatting.parseYMD(range.first) {
            var style = Date.FormatStyle.dateTime.month(.abbreviated).day()
                .locale(Locale(identifier: "en_US_POSIX"))
            style.timeZone = TimeZone(secondsFromGMT: 0) ?? .gmt
            start = date.formatted(style)
        } else {
            start = RatePlanTimelineFormatting.displayDate(range.first)
        }
        return "\(start) to \(end)"
    }
}

struct SavingsCaveat: Equatable, Sendable, Identifiable {
    enum Action: Equatable, Sendable {
        case editFixedRatePlan(suggestedStart: String?)
        case fixRatePlans
    }

    let text: String
    let action: Action

    var actionTitle: String {
        switch action {
        case .editFixedRatePlan: "Edit Fixed Rate Plan"
        case .fixRatePlans: "Fix Rate Plans"
        }
    }

    var id: String {
        switch action {
        case .editFixedRatePlan: "fixed"
        case .fixRatePlans: "ratePlan"
        }
    }
}

/// Builds API payloads for a single-rate-all-day reference rate plan.
enum FixedRatePlanDraft {
    static func formatRate(_ rate: Double, locale: Locale = .current) -> String {
        rate.formatted(.number.locale(locale).grouping(.never).precision(.fractionLength(0 ... 4)))
    }

    static func parseRate(_ raw: String, locale: Locale = .current) -> Double? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let value = try? Double(trimmed, format: .number.locale(locale)),
              value.isFinite,
              value >= 0 else { return nil }
        return value
    }

    static func makeWriteRequest(
        name: String,
        buyRate: Double,
        sellRate: Double,
        startsOn: Date,
        timeZone: TimeZone
    ) -> TariffPlanWriteRequest {
        TariffPlanWriteRequest(
            name: normalizedName(name),
            effectiveFrom: formatDate(startsOn, timeZone: timeZone),
            effectiveTo: nil,
            seasons: makeSeasons(buyRate: buyRate, sellRate: sellRate)
        )
    }

    static func makePatchRequest(_ request: TariffPlanWriteRequest) -> TariffPlanPatchRequest {
        TariffPlanPatchRequest(
            name: request.name,
            effectiveFrom: request.effectiveFrom,
            effectiveTo: .unchanged,
            seasons: request.seasons
        )
    }

    private static func normalizedName(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Fixed Rate Plan" : trimmed
    }

    private static func makeSeasons(
        buyRate: Double,
        sellRate: Double
    ) -> [TariffSeasonInput] {
        let window = TimePeriodWindowInput(
            touName: .offPeak,
            fromHour: 0,
            fromMinute: 0,
            toHour: 24,
            toMinute: 0,
            buyRate: buyRate,
            sellRate: sellRate
        )
        return [
            TariffSeasonInput(
                name: "All Year",
                fromMonth: 1,
                toMonth: 12,
                weekdayPeriods: [window],
                weekendPeriods: [window],
                fromDay: 1,
                toDay: 31
            )
        ]
    }

    private static func formatDate(_ date: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        let year = components.year ?? 2026
        let month = components.month ?? 1
        let day = components.day ?? 1
        return String(format: "%04d-%02d-%02d", year, month, day)
    }
}
