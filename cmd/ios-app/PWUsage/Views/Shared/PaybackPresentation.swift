import Foundation

/// User-facing copy for the Payback section. Pure formatting; views render what these return.
enum PaybackPresentation {
    private static let neverText = "not within \(PaybackCalculator.horizonYears) years"
    private static let usageLine = "Your usage stays like the last 12 months"
    private static let posixLocale = Locale(identifier: "en_US_POSIX")

    /// Headline for the combined payback, or the single component, e.g. `"Paid back about $9,050 of $26,250"`.
    /// Reads only the numbers, so the placeholder component on a combined payback does not matter.
    static func headline(
        _ payback: ComponentPayback,
        currency: String,
        locale: Locale = .current
    ) -> String {
        let paid = SavingsPresentation.aboutAmount(max(0, payback.paidToDate), currency: currency, locale: locale)
        return "Paid back \(paid) of \(plainCurrency(payback.netCost, currency: currency, locale: locale))"
    }

    /// The date line under the headline, e.g. `"Paid off around summer 2035"`. Nil when there is no cost.
    static func breakEvenLine(_ breakEven: BreakEven, timeZone: TimeZone) -> String? {
        switch breakEven {
        case let .paidOff(month), let .projected(month):
            "Paid off around \(seasonText(month: month, timeZone: timeZone))"
        case .notWithinHorizon:
            neverText
        case let .needsFullYear(countedDays):
            "We’ll estimate when it pays for itself once a full year of savings is counted "
                + "(\(countedDays) of \(PaybackCalculator.minimumCountedDays) days so far)."
        case .noCost:
            nil
        }
    }

    /// One component row: its title, its paid-of-cost amount and, when known, its break-even phrase.
    struct ComponentLines: Equatable {
        let title: String
        let amount: String
        let when: String?
    }

    static func componentLines(
        _ payback: ComponentPayback,
        currency: String,
        timeZone: TimeZone,
        locale: Locale = .current
    ) -> ComponentLines {
        let paid = SavingsPresentation.aboutAmount(max(0, payback.paidToDate), currency: currency, locale: locale)
        let cost = plainCurrency(payback.netCost, currency: currency, locale: locale)
        let title: String
        let since: String
        switch payback.component {
        case .solar:
            title = "Solar"
            since = ""
        case .powerwall:
            title = "Powerwall"
            since = ", since \(RatePlanTimelineFormatting.displayDate(payback.since))"
        }
        return ComponentLines(
            title: title,
            amount: "\(paid) of \(cost)\(since)",
            when: componentWhen(payback.breakEven, timeZone: timeZone)
        )
    }

    /// The season and year a month falls in, e.g. `"spring 2031"`. December counts toward the next winter.
    static func seasonText(month: Date, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month], from: month)
        let year = parts.year ?? 0
        let monthNumber = parts.month ?? 1
        switch monthNumber {
        case 3 ... 5: return "spring \(year)"
        case 6 ... 8: return "summer \(year)"
        case 9 ... 11: return "fall \(year)"
        case 12: return "winter \(year + 1)"
        default: return "winter \(year)"
        }
    }

    /// Share of the net cost paid back, from 0 to 1. Zero when there is no cost to recover.
    static func progress(_ payback: ComponentPayback) -> Double {
        guard payback.netCost > 0 else { return 0 }
        return min(max(payback.paidToDate / payback.netCost, 0), 1)
    }

    /// The assumptions a projection rests on. The Powerwall line appears only when a Powerwall has a stream.
    static func assumptionLines(_ assumptions: PaybackAssumptions, hasPowerwall: Bool) -> [String] {
        var lines = [
            usageLine,
            rateLine(assumptions.rateGrowth),
            solarLine(assumptions.solarDecline, measured: assumptions.solarDeclineMeasured)
        ]
        if hasPowerwall {
            let fade = assumptions.batteryFadePerYear ?? PaybackCalculator.batteryFadePerYear
            lines.append(
                "Powerwall capacity falls about \(percent(fade)) a year, "
                    + "in line with Tesla’s warranty (70% after 10 years)"
            )
        }
        return lines
    }

    /// Shown only when the Powerwall will not pay for itself within the horizon.
    static func powerwallNeverNote(_ result: PaybackResult) -> String? {
        guard let powerwall = result.components.first(where: { $0.component == .powerwall }),
              powerwall.breakEven == .notWithinHorizon else { return nil }
        return "At its current pace, your Powerwall won’t pay for itself "
            + "within \(PaybackCalculator.horizonYears) years. "
            + "Under full net metering a battery adds little to savings."
    }

    // MARK: Helpers

    private static func componentWhen(_ breakEven: BreakEven, timeZone: TimeZone) -> String? {
        switch breakEven {
        case let .projected(month):
            "around \(seasonText(month: month, timeZone: timeZone))"
        case let .paidOff(month):
            "paid off around \(seasonText(month: month, timeZone: timeZone))"
        case .notWithinHorizon:
            neverText
        case .needsFullYear, .noCost:
            nil
        }
    }

    private static func rateLine(_ growth: RateGrowth) -> String {
        let rate = percent(growth.annualRate)
        guard growth.isMeasured, let since = growth.measuredSince else {
            return "Rates rise about \(rate) a year, a typical pace"
        }
        return "Rates rise about \(rate) a year, the pace of your rate plans since \(String(since.prefix(4)))"
    }

    private static func solarLine(_ decline: Double, measured: Bool) -> String {
        let rate = percent(decline)
        guard measured else { return "Solar output falls about \(rate) a year, a typical rate" }
        return "Solar output falls about \(rate) a year, as Panel Health measured"
    }

    /// A fraction as a percent with one decimal when it is not whole, e.g. `0.041` gives `"4.1%"`, `0.03` gives `"3%"`.
    private static func percent(_ fraction: Double) -> String {
        let value = (fraction * 100).formatted(.number.locale(posixLocale).precision(.fractionLength(0 ... 1)))
        return "\(value)%"
    }

    private static func plainCurrency(_ value: Double, currency: String, locale: Locale) -> String {
        value.rounded().formatted(
            .currency(code: currency)
                .locale(locale)
                .precision(.fractionLength(0))
        )
    }
}
