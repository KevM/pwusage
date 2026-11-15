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
}

/// Builds API payloads for a single-rate-all-day reference rate plan.
enum FixedRatePlanDraft {
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
