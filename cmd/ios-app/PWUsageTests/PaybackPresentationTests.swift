import Foundation
@testable import PWUsage
import Testing

@Suite("Payback Presentation")
struct PaybackPresentationTests {
    private static let usLocale = Locale(identifier: "en_US")
    private static let utc = TimeZone(secondsFromGMT: 0) ?? .gmt
    private static let tokyo = TimeZone(identifier: "Asia/Tokyo") ?? utc

    private static func monthStart(_ year: Int, _ month: Int, in timeZone: TimeZone = utc) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: DateComponents(year: year, month: month, day: 1)) ?? .distantPast
    }

    private static func payback(
        _ component: SystemComponent = .solar,
        netCost: Double = 16_100,
        paid: Double = 7_840,
        since: String = "2023-11-14",
        breakEven: BreakEven = .notWithinHorizon
    ) -> ComponentPayback {
        ComponentPayback(component: component, netCost: netCost, paidToDate: paid, since: since, breakEven: breakEven)
    }

    private static let measuredGrowth = RateGrowth(annualRate: 0.041, isMeasured: true, measuredSince: "2019-06-01")

    @Test("Headline matches fixed copy and ignores the component label")
    func headlineMatchesCopy() {
        let total = Self.payback(.solar, netCost: 26_250, paid: 9_050)
        #expect(
            PaybackPresentation.headline(total, currency: "USD", locale: Self.usLocale)
                == "Paid back about $9,050 of $26,250"
        )
        let placeholder = Self.payback(.powerwall, netCost: 26_250, paid: 9_050)
        #expect(
            PaybackPresentation.headline(placeholder, currency: "USD", locale: Self.usLocale)
                == PaybackPresentation.headline(total, currency: "USD", locale: Self.usLocale)
        )
    }

    @Test("Season text maps months to seasons and December to the next winter")
    func seasonTextMapsMonths() {
        #expect(PaybackPresentation.seasonText(month: Self.monthStart(2031, 3), timeZone: Self.utc) == "spring 2031")
        #expect(PaybackPresentation.seasonText(month: Self.monthStart(2031, 6), timeZone: Self.utc) == "summer 2031")
        #expect(PaybackPresentation.seasonText(month: Self.monthStart(2031, 9), timeZone: Self.utc) == "fall 2031")
        #expect(PaybackPresentation.seasonText(month: Self.monthStart(2029, 12), timeZone: Self.utc) == "winter 2030")
        #expect(PaybackPresentation.seasonText(month: Self.monthStart(2030, 2), timeZone: Self.utc) == "winter 2030")
    }

    @Test("Season text uses the site's time zone for the month")
    func seasonTextUsesSiteTimeZone() {
        let tokyoMarch = Self.monthStart(2031, 3, in: Self.tokyo)
        #expect(PaybackPresentation.seasonText(month: tokyoMarch, timeZone: Self.tokyo) == "spring 2031")
    }

    @Test("Break-even lines for each case")
    func breakEvenLinesForEachCase() {
        let utc = Self.utc
        #expect(
            PaybackPresentation.breakEvenLine(.projected(month: Self.monthStart(2035, 7)), timeZone: utc)
                == "Paid off around summer 2035"
        )
        #expect(
            PaybackPresentation.breakEvenLine(.paidOff(month: Self.monthStart(2024, 10)), timeZone: utc)
                == "Paid off around fall 2024"
        )
        #expect(PaybackPresentation.breakEvenLine(.notWithinHorizon, timeZone: utc) == "Not within 30 years")
        #expect(
            PaybackPresentation.breakEvenLine(.needsFullYear(countedDays: 214), timeZone: utc)
                == "We’ll estimate when it pays for itself once a full year of savings is counted "
                + "(214 of 300 days so far)."
        )
        #expect(PaybackPresentation.breakEvenLine(.noCost, timeZone: utc) == nil)
    }

    @Test("Hold-back line shows counted days against the minimum")
    func holdBackLineShowsCountedDays() {
        let line = PaybackPresentation.breakEvenLine(.needsFullYear(countedDays: 12), timeZone: Self.utc)
        #expect(line?.contains("(12 of 300 days so far)") == true)
    }

    @Test("Component lines use the around form, the paid-off form and the never form")
    func componentLinesForEachCase() {
        let solar = PaybackPresentation.componentLines(
            Self.payback(.solar, breakEven: .projected(month: Self.monthStart(2031, 3))),
            currency: "USD", timeZone: Self.utc, locale: Self.usLocale
        )
        #expect(solar.title == "Solar")
        #expect(solar.amount == "about $7,840 of $16,100")
        #expect(solar.when == "around spring 2031")

        let powerwall = PaybackPresentation.componentLines(
            Self.payback(.powerwall, netCost: 10_150, paid: 1_210, since: "2024-03-04",
                         breakEven: .projected(month: Self.monthStart(2041, 10))),
            currency: "USD", timeZone: Self.utc, locale: Self.usLocale
        )
        #expect(powerwall.title == "Powerwall")
        #expect(powerwall.amount == "about $1,210 of $10,150, since Mar 4, 2024")
        #expect(powerwall.when == "around fall 2041")

        let paidOff = PaybackPresentation.componentLines(
            Self.payback(.solar, breakEven: .paidOff(month: Self.monthStart(2023, 3))),
            currency: "USD", timeZone: Self.utc, locale: Self.usLocale
        )
        #expect(paidOff.when == "paid off around spring 2023")

        let never = PaybackPresentation.componentLines(
            Self.payback(.powerwall, breakEven: .notWithinHorizon),
            currency: "USD", timeZone: Self.utc, locale: Self.usLocale
        )
        #expect(never.when == "not within 30 years")

        let held = PaybackPresentation.componentLines(
            Self.payback(.solar, breakEven: .needsFullYear(countedDays: 100)),
            currency: "USD", timeZone: Self.utc, locale: Self.usLocale
        )
        #expect(held.when == nil)
    }

    @Test("Assumption lines for measured rates and the typical defaults")
    func assumptionLinesMeasuredAndDefault() {
        let measured = PaybackAssumptions(
            rateGrowth: Self.measuredGrowth,
            solarDecline: 0.006,
            solarDeclineMeasured: true,
            batteryFadePerYear: 0.03
        )
        #expect(PaybackPresentation.assumptionLines(measured, hasPowerwall: true) == [
            "Your usage stays like the last 12 months",
            "Rates rise about 4.1% a year, the pace of your rate plans since 2019",
            "Solar output falls about 0.6% a year, as Panel Health measured",
            "Powerwall capacity falls about 3% a year, in line with Tesla’s warranty (70% after 10 years)"
        ])

        let defaults = PaybackAssumptions(
            rateGrowth: .typical,
            solarDecline: 0.005,
            solarDeclineMeasured: false,
            batteryFadePerYear: nil
        )
        #expect(PaybackPresentation.assumptionLines(defaults, hasPowerwall: false) == [
            "Your usage stays like the last 12 months",
            "Rates rise about 3% a year, a typical pace",
            "Solar output falls about 0.5% a year, a typical rate"
        ])
    }

    @Test("Progress is the paid share, clamped, and zero when there is no cost")
    func progressClampsAndHandlesZeroCost() {
        #expect(PaybackPresentation.progress(Self.payback(netCost: 100, paid: 50)) == 0.5)
        #expect(PaybackPresentation.progress(Self.payback(netCost: 100, paid: 150)) == 1)
        #expect(PaybackPresentation.progress(Self.payback(netCost: 100, paid: -20)) == 0)
        #expect(PaybackPresentation.progress(Self.payback(netCost: 0, paid: 10)) == 0)
        #expect(PaybackPresentation.progress(Self.payback(netCost: -5, paid: 10)) == 0)
    }

    @Test("Powerwall never note appears only when the Powerwall never pays off")
    func powerwallNeverNoteOnlyWhenNever() {
        let never = PaybackResult(
            components: [Self.payback(.solar), Self.payback(.powerwall, breakEven: .notWithinHorizon)],
            combined: nil,
            assumptions: PaybackAssumptions(
                rateGrowth: .typical, solarDecline: 0.005, solarDeclineMeasured: false, batteryFadePerYear: 0.03
            ),
            coverage: SavingsFigures(costs: .zero, daysWithData: 0, daysInPeriod: 0)
        )
        #expect(
            PaybackPresentation.powerwallNeverNote(never)
                == "At its current pace, your Powerwall won’t pay for itself within 30 years. "
                + "Under full net metering a battery adds little to savings."
        )

        let projected = PaybackResult(
            components: [Self.payback(.powerwall, breakEven: .projected(month: Self.monthStart(2041, 10)))],
            combined: nil,
            assumptions: never.assumptions,
            coverage: never.coverage
        )
        #expect(PaybackPresentation.powerwallNeverNote(projected) == nil)
    }

    @Test("Assumptions show under a projected or not-within-horizon date, and stay hidden otherwise")
    func assumptionsShowOnlyForProjection() {
        let assumptions = PaybackAssumptions(
            rateGrowth: Self.measuredGrowth, solarDecline: 0.005, solarDeclineMeasured: false, batteryFadePerYear: nil
        )
        let coverage = SavingsFigures(costs: .zero, daysWithData: 300, daysInPeriod: 365)
        func result(_ breakEven: BreakEven) -> PaybackResult {
            PaybackResult(
                components: [Self.payback(breakEven: breakEven)], combined: nil,
                assumptions: assumptions, coverage: coverage
            )
        }
        #expect(PaybackPresentation.showsAssumptions(result(.projected(month: Self.monthStart(2035, 7)))))
        #expect(PaybackPresentation.showsAssumptions(result(.notWithinHorizon)))
        #expect(!PaybackPresentation.showsAssumptions(result(.paidOff(month: Self.monthStart(2024, 10)))))
        #expect(!PaybackPresentation.showsAssumptions(result(.needsFullYear(countedDays: 214))))
        #expect(!PaybackPresentation.showsAssumptions(result(.noCost)))
    }

    @Test("Assumptions show when a component is projected even if the combined date is paid off")
    func assumptionsShowForProjectedComponent() {
        let assumptions = PaybackAssumptions(
            rateGrowth: Self.measuredGrowth, solarDecline: 0.005, solarDeclineMeasured: false, batteryFadePerYear: nil
        )
        let coverage = SavingsFigures(costs: .zero, daysWithData: 300, daysInPeriod: 365)
        let paidOff = BreakEven.paidOff(month: Self.monthStart(2024, 10))
        func result(powerwall: BreakEven) -> PaybackResult {
            PaybackResult(
                components: [
                    Self.payback(.solar, breakEven: paidOff),
                    Self.payback(.powerwall, breakEven: powerwall)
                ],
                combined: Self.payback(.solar, netCost: 26_250, paid: 26_250, breakEven: paidOff),
                assumptions: assumptions, coverage: coverage
            )
        }
        #expect(PaybackPresentation.showsAssumptions(result(powerwall: .projected(month: Self.monthStart(2041, 10)))))
        #expect(PaybackPresentation.showsAssumptions(result(powerwall: .notWithinHorizon)))
        #expect(!PaybackPresentation.showsAssumptions(result(powerwall: paidOff)))
    }
}
