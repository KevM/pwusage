import Foundation
@testable import PWUsage
import Testing

extension SmartShiftPresentationTests {
    // MARK: - Bill-date projection and the safety rule

    static func shortDate(_ date: Date) -> String { SmartShiftPresentation.shortDate(date, timeZone: "UTC") }

    static let cycleEnd = at(24 * 24)

    /// Harrison's tariff and car (52.7 kWh at 9 kW) with the bill-date projection filled in.
    static func cycleComparison(
        now: Date,
        recommendedStart: Date,
        costs: StartCosts,
        banks: BankPair,
        safety: Estimator.Safety = .nowSafe,
        ruledOut: Estimator.RuledOut? = nil,
        projectionEnd: Date = cycleEnd,
        endsAtRateChange: Bool = false,
        usesHistory: Bool = false
    ) -> Estimator.Comparison {
        func lane(_ key: String, _ values: BankValues) -> Estimator.BalanceLane {
            Estimator.BalanceLane(periodKey: key, startKwh: values.start,
                                  recommended: [.init(date: now, kwh: values.start),
                                                .init(date: horizonEnd, kwh: values.later)],
                                  startNow: [.init(date: now, kwh: values.start),
                                             .init(date: horizonEnd, kwh: values.startNow)],
                                  projectedKwh: values.projected, projectedAfterRecommendedKwh: values.afterLater,
                                  projectedAfterStartNowKwh: values.afterNow)
        }
        return Estimator.Comparison(
            costNow: costs.costNow, recommendedStart: recommendedStart,
            recommendedEnd: recommendedStart.addingTimeInterval(52.7 / 9 * 3600),
            recommendedCost: costs.recommendedCost, savings: costs.savings, bestAlternativeSavings: costs.savings,
            estimatedSolarContribution: 0,
            horizonStart: now, horizonEnd: horizonEnd, evaluatedStarts: [now, recommendedStart], assumptions: [],
            hasUnobservedBalance: false, lanes: [lane("OFF_PEAK", banks.offPeak), lane("ON_PEAK", banks.onPeak)],
            periodSwitches: [at(32), at(44)], projectionEnd: projectionEnd,
            projectionEndsAtRateChange: endsAtRateChange,
            safetyEnd: now.addingTimeInterval(7 * 86_400), safety: safety, ruledOut: ruledOut, usesHistory: usesHistory)
    }

    /// Friday 13:12, Off-Peak and owed. Tomorrow's On-Peak (08:00–20:00) bank recovers to +60 by the bill date,
    /// so charging all of the car in On-Peak tomorrow at 8:00 AM costs 52.7 kWh × 4¢.
    static func morningDip(safety: Estimator.Safety = .nowSafe, ruledOut: Estimator.RuledOut? = nil,
                           endsAtRateChange: Bool = false) -> (comparison: Estimator.Comparison, now: Date) {
        let now = at(13.2)
        return (cycleComparison(now: now, recommendedStart: at(32),
                                costs: StartCosts(costNow: 5.27, recommendedCost: 2.108, savings: 3.162),
                                banks: BankPair(onPeak: BankValues(5, -19.7, 33, 60, 7.3, 60),
                                                offPeak: BankValues(-64, -64, -116.7, -90, -90, -142.7)),
                                safety: safety, ruledOut: ruledOut, endsAtRateChange: endsAtRateChange), now)
    }

    /// Saturday 08:30 in On-Peak: starting now dips into On-Peak, which a cloudy week leaves short.
    static func unsafeNow(ruledOut: Estimator.RuledOut? = nil) -> (comparison: Estimator.Comparison, now: Date) {
        let now = at(32.5)
        return (cycleComparison(now: now, recommendedStart: at(44),
                                costs: StartCosts(costNow: 2.108, recommendedCost: 5.27, savings: 0),
                                banks: BankPair(onPeak: BankValues(5, 5, -19.7, 60, 60, 7.3),
                                                offPeak: BankValues(-64, -100, -64, -90, -142.7, -90)),
                                safety: .nowUnsafe(periodKey: "ON_PEAK"), ruledOut: ruledOut), now)
    }

    static func cycleVerdict(_ comparison: Estimator.Comparison, now: Date, forecast: ForecastAvailability = .ready,
                             profile: LoadProfile = harrisonSunday().car) throws -> SmartShiftVerdict {
        try verdict(SmartShiftPresentation.make(
            profile: profile, result: .init(comparison: comparison, unavailableReason: nil),
            forecast: forecast, refreshUnavailable: false,
            inputs: .init(timing: harrisonSunday().timing, now: now, billingCycleEnd: cycleEnd,
                          currencyCode: "USD", timeZone: "UTC")))
    }

    @Test func headlineWhenTheSafeStartCostsMoreThanNow() throws {
        let (comparison, now) = Self.unsafeNow()
        let verdict = try Self.cycleVerdict(comparison, now: now)
        #expect(Self.normalized(Self.legacyHeadline(verdict))
            == "Charge the car at 8:00 PM: about \(Self.money(3.16)) more than now, but it won't leave On-Peak short")
        #expect(verdict.choices.map { $0.id == .recommended } == [true, false])
    }

    @Test func headlineWhenNoStartIsSafe() throws {
        let (comparison, now) = Self.morningDip(safety: .noSafeStart(periodKey: "ON_PEAK"))
        let verdict = try Self.cycleVerdict(comparison, now: now)
        #expect(Self.normalized(Self.legacyHeadline(verdict))
            == "Charge the car tomorrow at 8:00 AM: the least risky time, "
            + "but a cloudy week could still leave On-Peak short")
        #expect(!Self.legacyHeadline(verdict).contains("cheaper"))
    }

    @Test func headlineWhenNoStartIsSafeAndNowIsLeastRisky() throws {
        let (dip, now) = Self.unsafeNow()
        let comparison = Self.cycleComparison(
            now: now, recommendedStart: now,
            costs: StartCosts(costNow: 2.108, recommendedCost: 2.108, savings: 0),
            banks: BankPair(onPeak: BankValues(5, -19.7, -19.7, 60, 7.3, 7.3),
                            offPeak: BankValues(-64, -64, -64, -90, -90, -90)),
            safety: .noSafeStart(periodKey: "ON_PEAK"))
        #expect(dip.safety != comparison.safety)
        let verdict = try Self.cycleVerdict(comparison, now: now)
        #expect(Self.legacyHeadline(verdict)
            == "Charge the car now: the least risky time, but a cloudy week could still leave On-Peak short")
        #expect(verdict.choices.count == 1)
    }

    @Test func whyLineNamesTheProjectedBankALaterStartUses() throws {
        let (comparison, now) = Self.morningDip()
        let verdict = try Self.cycleVerdict(comparison, now: now)
        #expect(Self.normalized(verdict.why)
            == "Starting now runs during Off-Peak, where you have no bank, so it's bought at \(Self.rate(0.10)). "
            + "Tomorrow at 8:00 AM it uses your On-Peak bank, projected at +60 kWh by "
            + "\(Self.shortDate(Self.cycleEnd)), "
            + "giving up \(Self.rate(0.04)) in credit.")
    }

    @Test func whyLineWhenStartingNowIsUnsafe() throws {
        let (comparison, now) = Self.unsafeNow()
        let verdict = try Self.cycleVerdict(comparison, now: now)
        #expect(Self.normalized(verdict.why)
            == "Starting now would draw on your On-Peak bank, which a cloudy week could leave more than 3 kWh short by "
            + "\(Self.shortDate(comparison.safetyEnd)). At 8:00 PM it's bought at the Off-Peak rate of "
            + "\(Self.rate(0.10)).")
    }

    @Test func bankNoteGivesTheBillDateProjectionBeforeAndAfterTheCharge() throws {
        let (comparison, now) = Self.morningDip()
        let harrison = Self.harrisonSunday()
        let breakdowns = SmartShiftPresentation.costBreakdowns(.init(
            comparison: comparison, profile: harrison.car, timing: harrison.timing, now: now,
            billingCycleEnd: Self.cycleEnd, currencyCode: "USD", timeZone: "UTC"))
        let later = try #require(breakdowns.first)
        // Draws use the bill-date bank, not the chart edge (where On-Peak ends at -19.7).
        #expect(later.lines == [
            CostLine(period: "On-Peak", detail: "52.7 kWh from your bank × \(Self.rate(0.04)) credit",
                     amount: Self.money(2.11))
        ])
        #expect(later.notes
            == ["On-Peak bank is +5 now, projecting +60 by \(Self.shortDate(Self.cycleEnd)) (bill date), "
                + "+7 after this charge."])
    }

    @Test func bankNoteSaysWhenRatesChange() throws {
        let (comparison, now) = Self.morningDip(endsAtRateChange: true)
        let harrison = Self.harrisonSunday()
        let breakdowns = SmartShiftPresentation.costBreakdowns(.init(
            comparison: comparison, profile: harrison.car, timing: harrison.timing, now: now,
            billingCycleEnd: Self.at(24 * 30), currencyCode: "USD", timeZone: "UTC"))
        #expect(try #require(breakdowns.first).notes
            == ["On-Peak bank is +5 now, projecting +60 by \(Self.shortDate(Self.cycleEnd)), "
                + "when rates change, +7 after this charge."])
    }

    @Test func ruledOutLineExplainsARejectedCheaperStart() throws {
        let (comparison, now) = Self.morningDip(ruledOut: .init(start: Self.at(36), cost: 1.5, periodKey: "ON_PEAK"))
        let harrison = Self.harrisonSunday()
        let note = SmartShiftPresentation.ruledOutNote(comparison: comparison, profile: harrison.car,
                                                       timing: harrison.timing, now: now, timeZone: "UTC")
        #expect(note.map(Self.normalized)
            == "Charging tomorrow at 12:00 PM would be cheaper if the sun holds, but a cloudy week could leave On-Peak "
            + "more than 3 kWh short by \(Self.shortDate(comparison.safetyEnd)), so it isn't suggested.")
        let dishes = LoadProfile(id: "dishwasher", name: "Wash the dishes", kind: .appliance, energyKwh: 1.5,
                                 durationHours: 2, carSettings: nil)
        #expect(SmartShiftPresentation.ruledOutNote(
            comparison: comparison, profile: dishes, timing: harrison.timing, now: now, timeZone: "UTC")?
            .hasPrefix("Washing ") == true)
        #expect(SmartShiftPresentation.ruledOutNote(
            comparison: comparison, profile: Self.pump, timing: harrison.timing, now: now, timeZone: "UTC")?
            .hasPrefix("Starting ") == true)
        #expect(SmartShiftPresentation.ruledOutNote(comparison: Self.morningDip().comparison, profile: harrison.car,
                                                    timing: harrison.timing, now: now, timeZone: "UTC") == nil)
    }

    @Test func noForecastNoteFollowsHistory() throws {
        let (dip, now) = Self.morningDip()
        let history = Self.cycleComparison(
            now: now, recommendedStart: dip.recommendedStart,
            costs: StartCosts(costNow: dip.costNow, recommendedCost: dip.recommendedCost, savings: dip.savings),
            banks: BankPair(onPeak: BankValues(5, -19.7, 33, 60, 7.3, 60),
                            offPeak: BankValues(-64, -64, -116.7, -90, -90, -142.7)),
            usesHistory: true)
        #expect(try Self.cycleVerdict(history, now: now, forecast: .none).notes == [.noForecast(usesHistory: true)])
        #expect(try Self.cycleVerdict(dip, now: now, forecast: .none).notes == [.noForecast(usesHistory: false)])
        #expect(SmartShiftPresentation.noForecastHistoryNote
            == "Solar forecasts aren't available for this home, so banks follow your last four weeks.")
        #expect(SmartShiftPresentation.noForecastNote
            == "Solar forecasts aren't available for this home, so banks are shown as they stand now.")
    }

    @Test func unsafeNowWithACheaperSafeStartStillClaimsTheSaving() throws {
        let now = Self.at(32.5)
        let comparison = Self.cycleComparison(
            now: now, recommendedStart: Self.at(44),
            costs: StartCosts(costNow: 2.83, recommendedCost: 1.00, savings: 1.83),
            banks: BankPair(onPeak: BankValues(1, 1, -9, 1, 1, -9),
                            offPeak: BankValues(-20, -30, -20, -20, -30, -20)),
            safety: .nowUnsafe(periodKey: "ON_PEAK"))
        let verdict = try Self.cycleVerdict(comparison, now: now)
        #expect(Self.normalized(Self.legacyHeadline(verdict))
            == "Charge the car at 8:00 PM: about \(Self.money(1.83)) cheaper than now")
        #expect(verdict.why.hasPrefix("Starting now would draw on your On-Peak bank"))
    }
}
