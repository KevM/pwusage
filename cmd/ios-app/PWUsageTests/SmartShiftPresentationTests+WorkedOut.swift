import Foundation
@testable import PWUsage
import Testing

extension SmartShiftPresentationTests {
    // MARK: - How this is worked out

    /// Raw server keys, listed out of tariff order on purpose.
    static func rawKeyTiming(hasCycleData: Bool = true) -> LoadTiming {
        let spans = [
            RateSpan(0, 7, "OFF_PEAK", 0.20, 0.26), RateSpan(7, 16, "ON_PEAK", 0.38, 0.10),
            RateSpan(16, 21, "PARTIAL_PEAK", 0.30, 0.12), RateSpan(21, 31, "OFF_PEAK", 0.20, 0.26)
        ]
        let segments = spans.map {
            LoadTimingTariffSegment(start: at($0.start), end: at($0.end), periodKey: $0.key, name: $0.key,
                                    buyRate: $0.buy, sellRate: $0.sell)
        }
        let periods = [("PARTIAL_PEAK", 0.0, 0.30, 0.12), ("ON_PEAK", -6.0, 0.38, 0.10),
                       ("OFF_PEAK", 18.0, 0.20, 0.26)].map {
            LoadTimingPeriod(name: $0.0, marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: $0.1,
                             isActive: false, nextStartPhrase: nil, buyRate: $0.2, sellRate: $0.3)
        }
        return LoadTiming(hasTariff: true, hasCycleData: hasCycleData, activeIsCheapest: false, periods: periods,
                          pricingPeriods: periods, tariffTimeline: segments, nextCheaper: nil, nextCheaperPhrase: nil,
                          nextStartPhraseByKey: [:])
    }

    @Test func periodRowsListEveryPricingPeriod() {
        let rows = SmartShiftPresentation.periodRows(timing: Self.rawKeyTiming(), currencyCode: "USD")
        #expect(rows.map(\.name) == ["Off-Peak", "On-Peak", "Partial-Peak"])
        #expect(rows.map(\.balance) == ["18 kWh banked", "6 kWh owed", "0 kWh"])
        #expect(rows[0].buy == DashboardPresentation.loadRate(0.20, code: "USD"))
        #expect(rows[0].sell == DashboardPresentation.loadRate(0.26, code: "USD"))
        let noCycle = SmartShiftPresentation.periodRows(timing: Self.rawKeyTiming(hasCycleData: false),
                                                        currencyCode: "USD")
        #expect(noCycle.allSatisfy { $0.balance == "No bank yet" })
    }

    @Test func rawPeriodKeysReadAsTitles() throws {
        let lanes = [Self.lane("ON_PEAK", start: -6, later: -6, startNow: -20),
                     Self.lane("OFF_PEAK", start: 18, later: 4, startNow: 18)]
        let screen = SmartShiftPresentation.make(
            profile: Self.pump, result: .init(comparison: Self.comparison(lanes: lanes), unavailableReason: nil),
            forecast: .ready, refreshUnavailable: false,
            inputs: .init(timing: Self.rawKeyTiming(), now: Self.now, billingCycleEnd: Self.at(480),
                          currencyCode: "USD", timeZone: "UTC"))
        let verdict = try Self.verdict(screen)
        #expect(verdict.lanes.map(\.title) == ["On-Peak (kWh)", "Off-Peak (kWh)"])
        #expect(verdict.why.hasPrefix("Starting now runs during On-Peak,"))
    }

    /// The owner's Sunday at Harrison: Off-Peak all weekend (10¢ buy, 3¢ credit) and owed; Monday
    /// On-Peak 08:00–20:00 (31¢ buy, 4¢ credit) banks tomorrow's solar from +5 to +33. The car
    /// draws 52.7 kWh over 5.86 h; at 16:30 tomorrow 31.5 kWh lands in On-Peak and 21.2 after 20:00.
    static func harrisonSunday() -> HarrisonSunday {
        let now = at(13.2)
        let car = LoadProfile(id: "car", name: "Charge the car", kind: .car, energyKwh: 0, durationHours: 0,
                              carSettings: CarLoadSettings(capacityKwh: 79.05, initialStateOfCharge: 20,
                                                           targetStateOfCharge: 80, chargingLevel: .level2))
        let spans = [RateSpan(0, 32, "OFF_PEAK", 0.10, 0.03), RateSpan(32, 44, "ON_PEAK", 0.31, 0.04),
                     RateSpan(44, 48, "OFF_PEAK", 0.10, 0.03)]
        let segments = spans.map {
            LoadTimingTariffSegment(start: at($0.start), end: at($0.end), periodKey: $0.key, name: $0.key,
                                    buyRate: $0.buy, sellRate: $0.sell)
        }
        let periods = [("OFF_PEAK", -64.0, 0.10, 0.03), ("ON_PEAK", 5.0, 0.31, 0.04)].map {
            LoadTimingPeriod(name: $0.0, marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: $0.1,
                             isActive: false, nextStartPhrase: nil, buyRate: $0.2, sellRate: $0.3)
        }
        let timing = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: periods,
                                pricingPeriods: periods, tariffTimeline: segments, nextCheaper: nil,
                                nextCheaperPhrase: nil,
                                nextStartPhraseByKey: [:])
        func lane(_ key: String, start: Double, later: Double, startNow: Double) -> Estimator.BalanceLane {
            Estimator.BalanceLane(periodKey: key, startKwh: start,
                                  recommended: [.init(date: now, kwh: start), .init(date: horizonEnd, kwh: later)],
                                  startNow: [.init(date: now, kwh: start), .init(date: horizonEnd, kwh: startNow)])
        }
        let duration = 52.7 / 9
        let comparison = Estimator.Comparison(
            costNow: 5.27, recommendedStart: at(40.5), recommendedEnd: at(40.5 + duration), recommendedCost: 3.38,
            savings: 1.89, bestAlternativeSavings: 1.89, estimatedSolarContribution: 0, horizonStart: now,
            horizonEnd: horizonEnd, evaluatedStarts: [now, at(40.5)], assumptions: [], hasUnobservedBalance: false,
            lanes: [lane("OFF_PEAK", start: -64, later: -93.5, startNow: -125),
                    lane("ON_PEAK", start: 5, later: 1.5, startNow: 33)],
            periodSwitches: [at(32), at(44)])
        return HarrisonSunday(timing: timing, comparison: comparison, now: now, car: car)
    }

    @Test func costBreakdownShowsTheArithmeticForBothStarts() throws {
        let harrison = Self.harrisonSunday()
        let breakdowns = SmartShiftPresentation.costBreakdowns(.init(
            comparison: harrison.comparison, profile: harrison.car, timing: harrison.timing, now: harrison.now,
            billingCycleEnd: Self.at(480), currencyCode: "USD", timeZone: "UTC"))
        #expect(breakdowns.count == 2)
        let later = try #require(breakdowns.first)
        #expect(Self.normalized(later.title) == "Charge tomorrow at 4:30 PM")
        #expect(later.total == Self.money(3.38))
        #expect(later.lines == [
            CostLine(period: "On-Peak", detail: "31.5 kWh from your bank × \(Self.rate(0.04)) credit",
                     amount: Self.money(1.26)),
            CostLine(period: "Off-Peak", detail: "21.2 kWh bought × \(Self.rate(0.10))",
                     amount: Self.money(2.12))
        ])
        // This fixture's projection ends at the chart edge, not the bill date.
        #expect(later.notes
            == ["On-Peak bank is +5 now, projecting +33 by \(Self.shortDate(Self.horizonEnd)), +2 after this charge."])
        let startNow = try #require(breakdowns.last)
        #expect(startNow.title == "Charge now")
        #expect(startNow.total == Self.money(5.27))
        #expect(startNow.lines
            == [CostLine(period: "Off-Peak", detail: "52.7 kWh bought × \(Self.rate(0.10))",
                         amount: Self.money(5.27))])
        #expect(startNow.notes.isEmpty)
    }

    @Test func costBreakdownSplitsAPartlyBankedPeriod() throws {
        // Off-Peak ends at -2 after the 14 kWh run: 12 kWh came from the bank, 2 were bought.
        let partLanes = [Self.lane("Peak", start: -6, later: -6, startNow: -20),
                         Self.lane("Off-Peak", start: 12, later: -2, startNow: 12)]
        let breakdowns = SmartShiftPresentation.costBreakdowns(.init(
            comparison: Self.comparison(lanes: partLanes), profile: Self.pump,
            timing: Self.timing(), now: Self.now, billingCycleEnd: Self.at(480),
            currencyCode: "USD", timeZone: "UTC"))
        #expect(try #require(breakdowns.first).lines == [
            CostLine(period: "Off-Peak", detail: "12.0 kWh from your bank × \(Self.rate(0.26)) credit",
                     amount: Self.money(3.12)),
            CostLine(period: "Off-Peak", detail: "2.0 kWh bought × \(Self.rate(0.20))", amount: Self.money(0.40))
        ])
    }

    @Test func costBreakdownWhenNowIsCheapestHasOneBlock() throws {
        let nowLanes = [Self.lane("Peak", start: -6, later: -20, startNow: -20)]
        let comparison = Self.comparison(costNow: 5.32, recommendedCost: 5.32,
                                         savings: 0, recommendedStart: Self.now, lanes: nowLanes)
        let breakdowns = SmartShiftPresentation.costBreakdowns(.init(
            comparison: comparison, profile: Self.pump, timing: Self.timing(),
            now: Self.now, billingCycleEnd: Self.at(480),
            currencyCode: "USD", timeZone: "UTC"))
        #expect(breakdowns.map(\.title) == ["Start now"])
    }

    // MARK: - A better Job

    @Test func hintsOnlyWhenAnotherJobSavesMore() {
        let dishes = LoadProfile(id: "dishwasher", name: "Wash the dishes", kind: .appliance, energyKwh: 5,
                                 durationHours: 2, carSettings: nil)
        let hint = SmartShiftPresentation.betterJobHint(
            selectedID: "car", savingsByJob: [(Self.car, 0.40), (dishes, 2.10)],
            currencyCode: "USD")
        #expect(hint
            == BetterJobHint(id: "dishwasher", text: "Wash the dishes: save about \(Self.money(2.10)) by waiting"))
        #expect(SmartShiftPresentation.betterJobHint(selectedID: "car",
                                                     savingsByJob: [(Self.car, 2.50), (dishes, 2.10)],
                                                     currencyCode: "USD") == nil)
        // A saving below one cent is not worth pointing at.
        #expect(SmartShiftPresentation.betterJobHint(selectedID: "car",
                                                     savingsByJob: [(Self.car, 0), (dishes, 0.004)],
                                                     currencyCode: "USD") == nil)
    }

    @Test func whyLineWhenNowIsCheapestUsesTheBillDateBank() throws {
        // Off-Peak is empty now but projected to refill to +50 by the bill date, so the
        // 40 kWh run is priced from the bank; the why line must say so, not "full rate".
        let refilling = [Estimator.BalanceLane(periodKey: "Off-Peak", startKwh: 0,
                                               recommended: [.init(date: Self.at(18), kwh: 0),
                                                             .init(date: Self.horizonEnd, kwh: -40)],
                                               startNow: [.init(date: Self.at(18), kwh: 0),
                                                          .init(date: Self.horizonEnd, kwh: -40)],
                                               projectedKwh: 50, projectedAfterRecommendedKwh: 10,
                                               projectedAfterStartNowKwh: 10)]
        let comparison = Estimator.Comparison(
            costNow: 1.04, recommendedStart: Self.at(18), recommendedEnd: Self.at(22.4),
            recommendedCost: 1.04, savings: 0,
            bestAlternativeSavings: 0, estimatedSolarContribution: 0, horizonStart: Self.at(18),
            horizonEnd: Self.horizonEnd,
            evaluatedStarts: [Self.at(18)], assumptions: [], hasUnobservedBalance: false, lanes: refilling,
            periodSwitches: [])
        let screen = SmartShiftPresentation.make(
            profile: Self.car, result: .init(comparison: comparison, unavailableReason: nil),
            forecast: .ready, refreshUnavailable: false,
            inputs: .init(timing: Self.timing(), now: Self.at(18), billingCycleEnd: Self.at(480),
                          currencyCode: "USD", timeZone: "UTC"))
        #expect(try Self.verdict(screen).why == "It's Off-Peak, and your Off-Peak bank covers all of this run.")
    }
}
