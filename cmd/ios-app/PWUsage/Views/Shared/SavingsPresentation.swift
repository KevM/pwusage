import Foundation
import PWUsageCore

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

    /// Share of counted days priced on estimated rates, e.g. `"About 40% of these days use estimated rates"`.
    /// Shares under 1% read `"Some of these days use estimated rates"`; no estimated days gives nil.
    static func estimatedShareLine(_ figures: SavingsFigures) -> String? {
        guard figures.estimatedDays > 0, figures.daysWithData > 0 else { return nil }
        let share = Double(figures.estimatedDays) * 100 / Double(figures.daysWithData)
        guard share >= 1 else { return "Some of these days use estimated rates" }
        return "About \(Int(share.rounded()))% of these days use estimated rates"
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

    /// The one savings button that opens Rate Plans, where fixed comparison plans are added and changed.
    struct RatePlansEntry: Equatable, Sendable {
        let title: String
        /// Opens the editor straight into adding the first plan.
        let startsAdding: Bool
    }

    static func ratePlansEntry(hasRatePlans: Bool) -> RatePlansEntry {
        RatePlansEntry(title: hasRatePlans ? "Edit Rate Plans" : "Add Rate Plans", startsAdding: !hasRatePlans)
    }

    static let billSetupPrompt = "Add your rate plans to see what your solar and Powerwall saved "
        + "compared with a fixed plan."
    static let solarSetupPrompt = "Add your rate plans to see how much your solar and Powerwall saved "
        + "over the past year and lifetime."

    static func showsCard(_ figures: SavingsFigures) -> Bool {
        figures.daysWithData > 0 || !caveats(figures).isEmpty
    }

    static func caveats(_ figures: SavingsFigures) -> [SavingsCaveat] {
        var result: [SavingsCaveat] = []
        if let gap = figures.gap(.noFixedRatePlan) {
            let text: String
            if let start = gap.fixedRatePlanStart {
                text = "Your fixed comparison plan starts \(RatePlanTimelineFormatting.displayDate(start)), "
                    + "so earlier days aren’t counted."
            } else {
                text = "We don’t have your fixed comparison plan for "
                    + "\(dayRangesText(gap.ranges, days: gap.days)), so those days aren’t counted."
            }
            result.append(SavingsCaveat(text: text, action: .openRatePlans))
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
        /// Opens Rate Plans, where the fixed comparison plans sit under each rate plan.
        case openRatePlans
        case fixRatePlans
    }

    let text: String
    let action: Action

    var actionTitle: String {
        switch action {
        case .openRatePlans: SavingsPresentation.ratePlansEntry(hasRatePlans: true).title
        case .fixRatePlans: "Fix Rate Plans"
        }
    }

    var id: String {
        switch action {
        case .openRatePlans: "fixed"
        case .fixRatePlans: "ratePlan"
        }
    }
}

/// Builds the selection request for a single-rate-all-day fixed comparison plan.
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

    /// A manual comparison for exactly `range`, as the guide and editor's locked-dates form send it.
    static func makeSelectionRequest(
        name: String,
        buyRate: Double,
        sellRate: Double,
        range: (from: String, to: String?)
    ) -> TariffSelectionRequest {
        TariffSelectionRequest(
            scope: .reference,
            candidate: .manual(
                name: normalizedName(name),
                seasons: makeSeasons(buyRate: buyRate, sellRate: sellRate)
            ),
            effectiveFrom: range.from,
            effectiveTo: range.to
        )
    }

    /// The name as saved: trimmed, `Fixed Rate Plan` when blank.
    static func normalizedName(_ raw: String) -> String {
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
}
