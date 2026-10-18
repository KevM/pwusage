import Foundation
import Testing
@testable import PWUsage

struct SmartShiftPresentationTests {
    typealias Estimator = LoadTimingForecastEstimator

    /// Local midnight in UTC; `start` in the estimator tests is 08:00 on this day.
    static let day0 = Date(timeIntervalSince1970: 1_800_000_000 - 8 * 3600)
    static func at(_ hours: Double) -> Date { day0.addingTimeInterval(hours * 3600) }
    static let now = at(8.5)
    static let horizonEnd = at(48)

    static let car = LoadProfile(id: "car", name: "Charge the car", kind: .car, energyKwh: 0, durationHours: 0,
        carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20, targetStateOfCharge: 80, chargingLevel: .level2))

    /// Peak 07:00–16:30, Off-Peak otherwise, over two days.
    static func timing(hasTariff: Bool = true) -> LoadTiming {
        let spans: [(Double, Double, String)] = [(0, 7, "Off-Peak"), (7, 16.5, "Peak"), (16.5, 31, "Off-Peak"),
                                                 (31, 40.5, "Peak"), (40.5, 48, "Off-Peak")]
        let segments = spans.map { from, to, key in
            LoadTimingTariffSegment(start: at(from), end: at(to), periodKey: key, name: key,
                                    buyRate: key == "Peak" ? 0.38 : 0.20, sellRate: key == "Peak" ? 0.10 : 0.26)
        }
        let periods = [("Peak", -6.0, 0.38, 0.10), ("Off-Peak", 18.0, 0.20, 0.26)].map { name, balance, buy, sell in
            LoadTimingPeriod(name: name, marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: balance,
                             isActive: name == "Peak", nextStartPhrase: nil, buyRate: buy, sellRate: sell)
        }
        return LoadTiming(hasTariff: hasTariff, hasCycleData: true, activeIsCheapest: false, periods: periods,
                          pricingPeriods: periods, tariffTimeline: segments, nextCheaper: nil, nextCheaperPhrase: nil,
                          nextStartPhraseByKey: [:])
    }

    static func lane(_ key: String, start: Double, later: Double, startNow: Double) -> Estimator.BalanceLane {
        Estimator.BalanceLane(periodKey: key, startKwh: start,
                              recommended: [.init(date: now, kwh: start), .init(date: horizonEnd, kwh: later)],
                              startNow: [.init(date: now, kwh: start), .init(date: horizonEnd, kwh: startNow)])
    }

    static let laterLanes = [lane("Peak", start: -6, later: -6, startNow: -20), lane("Off-Peak", start: 18, later: 4, startNow: 18)]

    static func comparison(
        costNow: Double = 5.27,
        recommendedCost: Double = 3.38,
        savings: Double = 1.89,
        recommendedStart: Date = at(16.5),
        lanes: [Estimator.BalanceLane] = laterLanes,
        hasUnobservedBalance: Bool = false
    ) -> Estimator.Comparison {
        Estimator.Comparison(
            costNow: costNow, recommendedStart: recommendedStart, recommendedEnd: recommendedStart.addingTimeInterval(5.9 * 3600),
            recommendedCost: recommendedCost, savings: savings, bestAlternativeSavings: savings,
            estimatedSolarContribution: 0, horizonStart: now, horizonEnd: horizonEnd,
            evaluatedStarts: [now, recommendedStart], assumptions: ["Held still."],
            hasUnobservedBalance: hasUnobservedBalance, lanes: lanes, periodSwitches: [at(16.5), at(31), at(40.5)])
    }

    static func make(
        profile: LoadProfile? = car,
        result: Estimator.Result = Estimator.Result(comparison: comparison(), unavailableReason: nil),
        forecast: ForecastAvailability = .none,
        refreshUnavailable: Bool = false,
        timing: LoadTiming = timing(),
        billingCycleEnd: Date = at(24 * 20)
    ) -> SmartShiftScreen {
        SmartShiftPresentation.make(profile: profile, result: result, forecast: forecast,
                                    refreshUnavailable: refreshUnavailable, timing: timing, now: now,
                                    billingCycleEnd: billingCycleEnd, currencyCode: "USD", timeZone: "UTC")
    }

    static func verdict(_ screen: SmartShiftScreen) throws -> SmartShiftVerdict {
        guard case .verdict(let verdict) = screen.content else {
            Issue.record("Expected a verdict, got \(screen.content)")
            throw CancellationError()
        }
        return verdict
    }

    static func blocked(_ screen: SmartShiftScreen) throws -> String {
        guard case .blocked(let message) = screen.content else {
            Issue.record("Expected a blocked message, got \(screen.content)")
            throw CancellationError()
        }
        return message
    }

    /// iOS 17+ `DateFormatter` separates a time from AM/PM with a narrow no-break space.
    static func normalized(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    static func money(_ amount: Double) -> String { DashboardPresentation.currency(amount, code: "USD") }

    @Test func laterStartVerdict() throws {
        let verdict = try Self.verdict(Self.make())
        #expect(Self.normalized(verdict.headline) == "Charge the car at 4:30 PM: about \(Self.money(1.89)) cheaper than now")
        #expect(verdict.barsCaption == "Added to your bill (shorter is better)")
        #expect(verdict.bars.count == 2)
        #expect(verdict.bars[0] == CostBar(label: "Charge later", amount: Self.money(3.38), value: 3.38, isRecommended: true))
        #expect(verdict.bars[1] == CostBar(label: "Charge now", amount: Self.money(5.27), value: 5.27, isRecommended: false))
        #expect(verdict.percentLess == "36% less")
        #expect(verdict.laterLabel == "Charge later")
        #expect(verdict.nowLabel == "Charge now")
        #expect(verdict.notes == [.connectSolcast(usesHistory: false)])
        // Now, each run's end, and each rate-period switch.
        #expect(verdict.axisDates == [Self.now, Self.at(14.4), Self.at(16.5), Self.at(22.4), Self.at(31), Self.at(40.5)])
    }

    @Test func laterStartTomorrowSaysSo() throws {
        let comparison = Self.comparison(recommendedStart: Self.at(40.5))
        let verdict = try Self.verdict(Self.make(result: .init(comparison: comparison, unavailableReason: nil)))
        #expect(Self.normalized(verdict.headline) == "Charge the car tomorrow at 4:30 PM: about \(Self.money(1.89)) cheaper than now")
        #expect(Self.normalized(verdict.why).contains("Tomorrow at 4:30 PM it"))
    }

    @Test func nowIsCheapestShowsOneBar() throws {
        let lanes = [Self.lane("Peak", start: -6, later: -20, startNow: -20)]
        let comparison = Self.comparison(costNow: 5.32, recommendedCost: 5.32, savings: 0, recommendedStart: Self.now, lanes: lanes)
        let verdict = try Self.verdict(Self.make(result: .init(comparison: comparison, unavailableReason: nil)))
        #expect(verdict.headline == "Charge the car now: no cheaper time today")
        #expect(verdict.barsCaption == "Added to your bill")
        #expect(verdict.bars == [CostBar(label: "Charge now", amount: Self.money(5.32), value: 5.32, isRecommended: true)])
        #expect(verdict.percentLess == nil)
        #expect(verdict.lanes.allSatisfy { $0.startNow == nil })
        #expect(verdict.lanes.allSatisfy { $0.endLabels.count == 1 })
        #expect(verdict.axisDates == [Self.now, Self.at(14.4), Self.at(16.5), Self.at(31), Self.at(40.5)])
    }

    @Test func startLabelsAndMergedEndLabels() throws {
        let lanes = [
            Self.lane("Off-Peak", start: 18, later: 4, startNow: 18),
            Self.lane("Peak", start: -6, later: 10.2, startNow: 9.8),
            Self.lane("Mid", start: 0.2, later: 0, startNow: -3),
        ]
        let verdict = try Self.verdict(Self.make(result: .init(comparison: Self.comparison(lanes: lanes), unavailableReason: nil)))
        #expect(verdict.lanes.map(\.title) == ["Off-Peak bank (kWh)", "Peak bank (kWh)", "Mid bank (kWh)"])
        #expect(verdict.lanes.map(\.startLabel) == ["+18 kWh banked now", "\u{2212}6 kWh owed now", "0 kWh now"])
        #expect(verdict.lanes[0].endLabels == ["+4", "+18"])
        #expect(verdict.lanes[1].endLabels == ["+10"])
        #expect(verdict.lanes[2].endLabels == ["0", "\u{2212}3"])
        #expect(verdict.lanes[0].switches == [
            SwitchMarker(date: Self.at(16.5), label: "\u{2190} Peak | Off-Peak \u{2192}"),
            SwitchMarker(date: Self.at(31), label: "\u{2190} Off-Peak | Peak \u{2192}"),
            SwitchMarker(date: Self.at(40.5), label: "\u{2190} Peak | Off-Peak \u{2192}"),
        ])
    }

    @Test func unobservedBalanceNote() throws {
        let comparison = Self.comparison(hasUnobservedBalance: true)
        let ready = try Self.verdict(Self.make(result: .init(comparison: comparison, unavailableReason: nil), forecast: .ready))
        #expect(ready.notes == [.unobservedBalance])
        let none = try Self.verdict(Self.make(result: .init(comparison: comparison, unavailableReason: nil), forecast: .none))
        #expect(none.notes == [.connectSolcast(usesHistory: false), .unobservedBalance])
    }

    @Test func forecastStatesBecomeNotes() throws {
        #expect(try Self.verdict(Self.make(forecast: .ready)).notes.isEmpty)
        #expect(try Self.verdict(Self.make(forecast: .loading)).notes == [.forecastState(SmartShiftPresentation.checkingSolarNote)])
        #expect(try Self.verdict(Self.make(forecast: .unusable("Solcast is limiting requests."))).notes
            == [.forecastState("Solcast is limiting requests.")])
    }

    @Test func customJobLegend() throws {
        let pump = LoadProfile(id: UUID().uuidString, name: "Pool pump", kind: .custom, energyKwh: 14, durationHours: 5.9, carSettings: nil)
        let verdict = try Self.verdict(Self.make(profile: pump))
        #expect(verdict.laterLabel == "Start later")
        #expect(verdict.nowLabel == "Start now")
        let dishes = LoadProfile(id: "dishwasher", name: "Wash the dishes", kind: .appliance, energyKwh: 5, durationHours: 2, carSettings: nil)
        #expect(try Self.verdict(Self.make(profile: dishes)).laterLabel == "Wash later")
    }

    @Test func noJobsWithoutProfile() {
        #expect(Self.make(profile: nil).content == .noJobs)
    }

    @Test func staleDataBlocks() throws {
        let message = try Self.blocked(Self.make(refreshUnavailable: true))
        #expect(message.contains("refresh failed"))
        let stale = try Self.blocked(Self.make(result: .init(comparison: nil, unavailableReason: .staleBalance)))
        #expect(stale.contains("older than one hour"))
    }

    @Test func missingRatePlanBlocks() throws {
        #expect(try Self.blocked(Self.make(timing: Self.timing(hasTariff: false))).contains("Rate Plan"))
        #expect(try Self.blocked(Self.make(result: .init(comparison: nil, unavailableReason: .missingTariff))).contains("Rate Plan"))
        #expect(try Self.blocked(Self.make(result: .init(comparison: nil, unavailableReason: .incompleteBalance))).contains("missing"))
    }

    @Test func billingCycleCrossingBlocks() throws {
        let pump = LoadProfile(id: UUID().uuidString, name: "Pool pump", kind: .custom, energyKwh: 14, durationHours: 5.9, carSettings: nil)
        let crossing = try Self.blocked(Self.make(profile: pump, result: .init(comparison: nil, unavailableReason: .noFittingRun),
                                                  billingCycleEnd: Self.now.addingTimeInterval(3600)))
        #expect(crossing.contains("beyond the current billing cycle"))
        #expect(!crossing.localizedCaseInsensitiveContains("cushion"))
        let tooLong = try Self.blocked(Self.make(profile: pump, result: .init(comparison: nil, unavailableReason: .noFittingRun)))
        #expect(tooLong == "This job is longer than the time Smart Shift can compare right now.")
    }

    static func rate(_ value: Double) -> String { DashboardPresentation.loadRate(value, code: "USD") }

    /// 14 kWh over 5.9 h, matching the fixture lanes' draws.
    static let pump = LoadProfile(id: UUID().uuidString, name: "Pool pump", kind: .custom, energyKwh: 14, durationHours: 5.9, carSettings: nil)

    @Test func whyLineNamesPeriods() throws {
        let verdict = try Self.verdict(Self.make(profile: Self.pump))
        #expect(Self.normalized(verdict.why) == "Starting now runs during Peak, where you have no bank, so it's bought at \(Self.rate(0.38)). "
            + "At 4:30 PM it uses your Off-Peak bank, giving up \(Self.rate(0.26)) in credit.")
    }

    @Test func whyLineExplainsRatesAndClaimsOnlyBanksTheRunDrawsFrom() throws {
        // The owner's Sunday: Off-Peak all day and owed; tomorrow On-Peak 08:00–20:00 banks solar
        // from +5 to +33. The car (40 kWh, 4.4 h) at 16:30 tomorrow puts 31.5 kWh into On-Peak's
        // bank and buys the last 8.5 kWh after 20:00 at the Off-Peak rate.
        let now = Self.at(12 + 38.0 / 60)
        let spans: [(Double, Double, String, Double, Double)] = [(0, 32, "Off-Peak", 0.132, 0.05), (32, 44, "On-Peak", 0.30, 0.072),
                                                                 (44, 48, "Off-Peak", 0.132, 0.05)]
        let segments = spans.map { LoadTimingTariffSegment(start: Self.at($0.0), end: Self.at($0.1), periodKey: $0.2, name: $0.2,
                                                          buyRate: $0.3, sellRate: $0.4) }
        let periods = [("Off-Peak", -66.0, 0.132, 0.05), ("On-Peak", 5.0, 0.30, 0.072)].map {
            LoadTimingPeriod(name: $0.0, marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: $0.1,
                             isActive: false, nextStartPhrase: nil, buyRate: $0.2, sellRate: $0.3)
        }
        let timing = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: periods,
                                pricingPeriods: periods, tariffTimeline: segments, nextCheaper: nil, nextCheaperPhrase: nil,
                                nextStartPhraseByKey: [:])
        func lane(_ key: String, start: Double, later: Double, startNow: Double) -> Estimator.BalanceLane {
            Estimator.BalanceLane(periodKey: key, startKwh: start,
                                  recommended: [.init(date: now, kwh: start), .init(date: Self.horizonEnd, kwh: later)],
                                  startNow: [.init(date: now, kwh: start), .init(date: Self.horizonEnd, kwh: startNow)])
        }
        let comparison = Estimator.Comparison(
            costNow: 5.27, recommendedStart: Self.at(40.5), recommendedEnd: Self.at(40.5 + 40.0 / 9), recommendedCost: 3.38,
            savings: 1.89, bestAlternativeSavings: 1.89, estimatedSolarContribution: 0, horizonStart: now,
            horizonEnd: Self.horizonEnd, evaluatedStarts: [now, Self.at(40.5)], assumptions: [], hasUnobservedBalance: false,
            lanes: [lane("Off-Peak", start: -66, later: -93, startNow: -124.5), lane("On-Peak", start: 5, later: 1.5, startNow: 33)],
            periodSwitches: [Self.at(32), Self.at(44)])
        let screen = SmartShiftPresentation.make(profile: Self.car, result: .init(comparison: comparison, unavailableReason: nil),
            forecast: .ready, refreshUnavailable: false, timing: timing, now: now, billingCycleEnd: Self.at(480),
            currencyCode: "USD", timeZone: "UTC")
        let why = Self.normalized(try Self.verdict(screen).why)
        #expect(!why.contains("Off-Peak bank"))
        #expect(why == "Starting now runs during Off-Peak, where you have no bank, so it's bought at \(Self.rate(0.132)). "
            + "Tomorrow at 4:30 PM it mostly uses your On-Peak bank, projected at +33 kWh by \(Self.shortDate(Self.horizonEnd)), "
            + "giving up \(Self.rate(0.072)) in credit.")
    }

    @Test func whyLineSaysMostlyWhenTheLaterRunSpansPeriods() throws {
        // 15:00 + 5.9 h puts 1.5 h in Peak and the rest in Off-Peak.
        let verdict = try Self.verdict(Self.make(profile: Self.pump, result: .init(
            comparison: Self.comparison(recommendedStart: Self.at(15)), unavailableReason: nil)))
        #expect(Self.normalized(verdict.why) == "Starting now runs during Peak, where you have no bank, so it's bought at \(Self.rate(0.38)). "
            + "At 3:00 PM it mostly uses your Off-Peak bank, giving up \(Self.rate(0.26)) in credit.")
    }

    @Test func whyLineWhenBothRunsCrossTheSamePeriodsNamesTheShift() throws {
        // 24 kWh over 20 h: starting now (08:30) spends 8 h in Peak, starting at 11:00 only 5.5 h.
        // Both runs cross Peak then Off-Peak, and no solar is involved.
        let pump = LoadProfile(id: UUID().uuidString, name: "Pool pump", kind: .custom, energyKwh: 24, durationHours: 20, carSettings: nil)
        let comparison = Estimator.Comparison(
            costNow: 4.37, recommendedStart: Self.at(11), recommendedEnd: Self.at(31), recommendedCost: 4.01, savings: 0.36,
            bestAlternativeSavings: 0.36, estimatedSolarContribution: 0, horizonStart: Self.now, horizonEnd: Self.horizonEnd,
            evaluatedStarts: [Self.now, Self.at(11)], assumptions: [], hasUnobservedBalance: false,
            lanes: Self.laterLanes, periodSwitches: [Self.at(16.5)])
        let verdict = try Self.verdict(Self.make(profile: pump, result: .init(comparison: comparison, unavailableReason: nil)))
        #expect(!verdict.why.localizedCaseInsensitiveContains("solar"))
        #expect(Self.normalized(verdict.why)
            == "Starting now puts more of it in Peak, where you have no bank. Run at 11:00 AM so less of it lands there.")
    }

    @Test func whyLineWhenNowIsCheapest() throws {
        let covered = [Self.lane("Off-Peak", start: 50, later: 10, startNow: 10)]
        // 25 kWh banked and nothing projected in, so the 40 kWh run leaves it 15 owed.
        let partly = [Estimator.BalanceLane(periodKey: "Off-Peak", startKwh: 25,
                                            recommended: [.init(date: Self.now, kwh: 25), .init(date: Self.horizonEnd, kwh: 0)],
                                            startNow: [.init(date: Self.now, kwh: 25), .init(date: Self.horizonEnd, kwh: 0)],
                                            projectedKwh: 25, projectedAfterRecommendedKwh: -15, projectedAfterStartNowKwh: -15)]
        let owed = [Self.lane("Off-Peak", start: -2, later: -42, startNow: -42)]
        func why(_ lanes: [Estimator.BalanceLane]) throws -> String {
            // At 18:00 the car (40 kWh from the wall) runs during Off-Peak.
            let comparison = Estimator.Comparison(
                costNow: 1, recommendedStart: Self.at(18), recommendedEnd: Self.at(22.4), recommendedCost: 1, savings: 0,
                bestAlternativeSavings: 0, estimatedSolarContribution: 0, horizonStart: Self.at(18), horizonEnd: Self.horizonEnd,
                evaluatedStarts: [Self.at(18)], assumptions: [], hasUnobservedBalance: false, lanes: lanes, periodSwitches: [])
            let screen = SmartShiftPresentation.make(profile: Self.car, result: .init(comparison: comparison, unavailableReason: nil),
                forecast: .none, refreshUnavailable: false, timing: Self.timing(), now: Self.at(18),
                billingCycleEnd: Self.at(480), currencyCode: "USD", timeZone: "UTC")
            return try Self.verdict(screen).why
        }
        #expect(try why(covered) == "It's Off-Peak, and your Off-Peak bank covers all of this run.")
        #expect(try why(partly) == "It's Off-Peak, and your Off-Peak bank covers most of this run.")
        #expect(try why(owed) == "It's Off-Peak; this run is bought at the full rate.")
    }

    @Test func whyLineWhenNowRunsIntoAnotherPeriod() throws {
        // 14 kWh over 4.4 h from 05:00 runs from Off-Peak into Peak; the later start stays in Off-Peak.
        let start = Self.at(5)
        let pump = LoadProfile(id: UUID().uuidString, name: "Pool pump", kind: .custom, energyKwh: 14, durationHours: 4.4, carSettings: nil)
        let comparison = Estimator.Comparison(
            costNow: 4, recommendedStart: Self.at(16.5), recommendedEnd: Self.at(20.9), recommendedCost: 2, savings: 2,
            bestAlternativeSavings: 2, estimatedSolarContribution: 0, horizonStart: start, horizonEnd: Self.horizonEnd,
            evaluatedStarts: [start], assumptions: [], hasUnobservedBalance: false,
            lanes: [Self.lane("Off-Peak", start: 18, later: 4, startNow: 11.6), Self.lane("Peak", start: -6, later: -6, startNow: -13.6)],
            periodSwitches: [Self.at(7)])
        let screen = SmartShiftPresentation.make(profile: pump, result: .init(comparison: comparison, unavailableReason: nil),
            forecast: .none, refreshUnavailable: false, timing: Self.timing(), now: start,
            billingCycleEnd: Self.at(480), currencyCode: "USD", timeZone: "UTC")
        #expect(Self.normalized(try Self.verdict(screen).why)
            == "Starting now runs into Peak, where you have no bank, so it's bought at \(Self.rate(0.38)). "
            + "At 4:30 PM it uses your Off-Peak bank, giving up \(Self.rate(0.26)) in credit.")
    }

    @Test func accessibilitySummaryReadsEveryLane() throws {
        let verdict = try Self.verdict(Self.make())
        #expect(verdict.accessibilitySummary == "Peak bank: \u{2212}6 kWh owed now; charge later leaves 6 kWh owed, charge now leaves 20 kWh owed. "
            + "Off-Peak bank: +18 kWh banked now; charge later leaves 4 kWh banked, charge now leaves 18 kWh banked.")
    }

    // MARK: - How this is worked out

    /// Raw server keys, listed out of tariff order on purpose.
    static func rawKeyTiming(hasCycleData: Bool = true) -> LoadTiming {
        let spans: [(Double, Double, String, Double, Double)] = [
            (0, 7, "OFF_PEAK", 0.20, 0.26), (7, 16, "ON_PEAK", 0.38, 0.10), (16, 21, "PARTIAL_PEAK", 0.30, 0.12),
            (21, 31, "OFF_PEAK", 0.20, 0.26),
        ]
        let segments = spans.map { LoadTimingTariffSegment(start: at($0.0), end: at($0.1), periodKey: $0.2, name: $0.2,
                                                          buyRate: $0.3, sellRate: $0.4) }
        let periods = [("PARTIAL_PEAK", 0.0, 0.30, 0.12), ("ON_PEAK", -6.0, 0.38, 0.10), ("OFF_PEAK", 18.0, 0.20, 0.26)].map {
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
        #expect(rows.map(\.balance) == ["+18 kWh banked", "\u{2212}6 kWh owed", "0 kWh"])
        #expect(rows[0].buy == DashboardPresentation.loadRate(0.20, code: "USD"))
        #expect(rows[0].sell == DashboardPresentation.loadRate(0.26, code: "USD"))
        let noCycle = SmartShiftPresentation.periodRows(timing: Self.rawKeyTiming(hasCycleData: false), currencyCode: "USD")
        #expect(noCycle.allSatisfy { $0.balance == "No balance yet" })
    }

    @Test func rawPeriodKeysReadAsTitles() throws {
        let lanes = [Self.lane("ON_PEAK", start: -6, later: -6, startNow: -20), Self.lane("OFF_PEAK", start: 18, later: 4, startNow: 18)]
        let screen = SmartShiftPresentation.make(
            profile: Self.pump, result: .init(comparison: Self.comparison(lanes: lanes), unavailableReason: nil),
            forecast: .ready, refreshUnavailable: false, timing: Self.rawKeyTiming(), now: Self.now,
            billingCycleEnd: Self.at(480), currencyCode: "USD", timeZone: "UTC")
        let verdict = try Self.verdict(screen)
        #expect(verdict.lanes.map(\.title) == ["On-Peak bank (kWh)", "Off-Peak bank (kWh)"])
        #expect(verdict.why.hasPrefix("Starting now runs during On-Peak,"))
    }

    /// The owner's Sunday at Harrison: Off-Peak all weekend (10¢ buy, 3¢ credit) and owed; Monday
    /// On-Peak 08:00–20:00 (31¢ buy, 4¢ credit) banks tomorrow's solar from +5 to +33. The car
    /// draws 52.7 kWh over 5.86 h; at 16:30 tomorrow 31.5 kWh lands in On-Peak and 21.2 after 20:00.
    static func harrisonSunday() -> (timing: LoadTiming, comparison: Estimator.Comparison, now: Date, car: LoadProfile) {
        let now = at(13.2)
        let car = LoadProfile(id: "car", name: "Charge the car", kind: .car, energyKwh: 0, durationHours: 0,
            carSettings: CarLoadSettings(capacityKwh: 79.05, initialStateOfCharge: 20, targetStateOfCharge: 80, chargingLevel: .level2))
        let spans: [(Double, Double, String, Double, Double)] = [(0, 32, "OFF_PEAK", 0.10, 0.03), (32, 44, "ON_PEAK", 0.31, 0.04),
                                                                 (44, 48, "OFF_PEAK", 0.10, 0.03)]
        let segments = spans.map { LoadTimingTariffSegment(start: at($0.0), end: at($0.1), periodKey: $0.2, name: $0.2,
                                                          buyRate: $0.3, sellRate: $0.4) }
        let periods = [("OFF_PEAK", -64.0, 0.10, 0.03), ("ON_PEAK", 5.0, 0.31, 0.04)].map {
            LoadTimingPeriod(name: $0.0, marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: $0.1,
                             isActive: false, nextStartPhrase: nil, buyRate: $0.2, sellRate: $0.3)
        }
        let timing = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: periods,
                                pricingPeriods: periods, tariffTimeline: segments, nextCheaper: nil, nextCheaperPhrase: nil,
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
            lanes: [lane("OFF_PEAK", start: -64, later: -93.5, startNow: -125), lane("ON_PEAK", start: 5, later: 1.5, startNow: 33)],
            periodSwitches: [at(32), at(44)])
        return (timing, comparison, now, car)
    }

    @Test func costBreakdownShowsTheArithmeticForBothStarts() throws {
        let (timing, comparison, now, car) = Self.harrisonSunday()
        let breakdowns = SmartShiftPresentation.costBreakdowns(comparison: comparison, profile: car, timing: timing, now: now,
                                                                billingCycleEnd: Self.at(480), currencyCode: "USD", timeZone: "UTC")
        #expect(breakdowns.count == 2)
        let later = try #require(breakdowns.first)
        #expect(Self.normalized(later.title) == "Charge tomorrow at 4:30 PM")
        #expect(later.total == Self.money(3.38))
        #expect(later.lines == [
            CostLine(period: "On-Peak", detail: "31.5 kWh from your bank × \(Self.rate(0.04)) credit", amount: Self.money(1.26)),
            CostLine(period: "Off-Peak", detail: "21.2 kWh bought × \(Self.rate(0.10))", amount: Self.money(2.12)),
        ])
        // This fixture's projection ends at the chart edge, not the bill date.
        #expect(later.notes == ["On-Peak bank is +5 now, projecting +33 by \(Self.shortDate(Self.horizonEnd)), +2 after this charge."])
        let startNow = try #require(breakdowns.last)
        #expect(startNow.title == "Charge now")
        #expect(startNow.total == Self.money(5.27))
        #expect(startNow.lines == [CostLine(period: "Off-Peak", detail: "52.7 kWh bought × \(Self.rate(0.10))", amount: Self.money(5.27))])
        #expect(startNow.notes.isEmpty)
    }

    @Test func costBreakdownSplitsAPartlyBankedPeriod() throws {
        // Off-Peak ends at -2 after the 14 kWh run: 12 kWh came from the bank, 2 were bought.
        let partLanes = [Self.lane("Peak", start: -6, later: -6, startNow: -20), Self.lane("Off-Peak", start: 12, later: -2, startNow: 12)]
        let breakdowns = SmartShiftPresentation.costBreakdowns(comparison: Self.comparison(lanes: partLanes), profile: Self.pump,
            timing: Self.timing(), now: Self.now, billingCycleEnd: Self.at(480), currencyCode: "USD", timeZone: "UTC")
        #expect(try #require(breakdowns.first).lines == [
            CostLine(period: "Off-Peak", detail: "12.0 kWh from your bank × \(Self.rate(0.26)) credit", amount: Self.money(3.12)),
            CostLine(period: "Off-Peak", detail: "2.0 kWh bought × \(Self.rate(0.20))", amount: Self.money(0.40)),
        ])
    }

    @Test func costBreakdownWhenNowIsCheapestHasOneBlock() throws {
        let nowLanes = [Self.lane("Peak", start: -6, later: -20, startNow: -20)]
        let comparison = Self.comparison(costNow: 5.32, recommendedCost: 5.32, savings: 0, recommendedStart: Self.now, lanes: nowLanes)
        let breakdowns = SmartShiftPresentation.costBreakdowns(comparison: comparison, profile: Self.pump, timing: Self.timing(),
                                                                now: Self.now, billingCycleEnd: Self.at(480), currencyCode: "USD",
                                                                timeZone: "UTC")
        #expect(breakdowns.map(\.title) == ["Start now"])
    }

    // MARK: - A better Job

    @Test func hintsOnlyWhenAnotherJobSavesMore() {
        let dishes = LoadProfile(id: "dishwasher", name: "Wash the dishes", kind: .appliance, energyKwh: 5, durationHours: 2, carSettings: nil)
        let hint = SmartShiftPresentation.betterJobHint(selectedID: "car", savingsByJob: [(Self.car, 0.40), (dishes, 2.10)],
                                                        currencyCode: "USD")
        #expect(hint == BetterJobHint(id: "dishwasher", text: "Wash the dishes: save about \(Self.money(2.10)) by waiting"))
        #expect(SmartShiftPresentation.betterJobHint(selectedID: "car", savingsByJob: [(Self.car, 2.50), (dishes, 2.10)],
                                                     currencyCode: "USD") == nil)
        // A saving below one cent is not worth pointing at.
        #expect(SmartShiftPresentation.betterJobHint(selectedID: "car", savingsByJob: [(Self.car, 0), (dishes, 0.004)],
                                                     currencyCode: "USD") == nil)
    }
}

// MARK: - Bill-date projection and the safety rule

extension SmartShiftPresentationTests {
    static func shortDate(_ date: Date) -> String { SmartShiftPresentation.shortDate(date, timeZone: "UTC") }

    static let cycleEnd = at(24 * 24)

    /// Harrison's tariff and car (52.7 kWh at 9 kW) with the bill-date projection filled in.
    static func cycleComparison(
        now: Date,
        recommendedStart: Date,
        costNow: Double,
        recommendedCost: Double,
        savings: Double,
        onPeak: (start: Double, later: Double, startNow: Double, projected: Double, afterLater: Double, afterNow: Double),
        offPeak: (start: Double, later: Double, startNow: Double, projected: Double, afterLater: Double, afterNow: Double),
        safety: Estimator.Safety = .nowSafe,
        ruledOut: Estimator.RuledOut? = nil,
        projectionEnd: Date = cycleEnd,
        endsAtRateChange: Bool = false,
        usesHistory: Bool = false
    ) -> Estimator.Comparison {
        func lane(_ key: String, _ v: (start: Double, later: Double, startNow: Double, projected: Double, afterLater: Double, afterNow: Double)) -> Estimator.BalanceLane {
            Estimator.BalanceLane(periodKey: key, startKwh: v.start,
                                  recommended: [.init(date: now, kwh: v.start), .init(date: horizonEnd, kwh: v.later)],
                                  startNow: [.init(date: now, kwh: v.start), .init(date: horizonEnd, kwh: v.startNow)],
                                  projectedKwh: v.projected, projectedAfterRecommendedKwh: v.afterLater,
                                  projectedAfterStartNowKwh: v.afterNow)
        }
        return Estimator.Comparison(
            costNow: costNow, recommendedStart: recommendedStart, recommendedEnd: recommendedStart.addingTimeInterval(52.7 / 9 * 3600),
            recommendedCost: recommendedCost, savings: savings, bestAlternativeSavings: savings, estimatedSolarContribution: 0,
            horizonStart: now, horizonEnd: horizonEnd, evaluatedStarts: [now, recommendedStart], assumptions: [],
            hasUnobservedBalance: false, lanes: [lane("OFF_PEAK", offPeak), lane("ON_PEAK", onPeak)],
            periodSwitches: [at(32), at(44)], projectionEnd: projectionEnd, projectionEndsAtRateChange: endsAtRateChange,
            safetyEnd: now.addingTimeInterval(7 * 86_400), safety: safety, ruledOut: ruledOut, usesHistory: usesHistory)
    }

    /// Friday 13:12, Off-Peak and owed. Tomorrow's On-Peak (08:00–20:00) bank recovers to +60 by the bill date,
    /// so charging all of the car in On-Peak tomorrow at 8:00 AM costs 52.7 kWh × 4¢.
    static func morningDip(safety: Estimator.Safety = .nowSafe, ruledOut: Estimator.RuledOut? = nil,
                           endsAtRateChange: Bool = false) -> (comparison: Estimator.Comparison, now: Date) {
        let now = at(13.2)
        return (cycleComparison(now: now, recommendedStart: at(32), costNow: 5.27, recommendedCost: 2.108, savings: 3.162,
                                onPeak: (5, -19.7, 33, 60, 7.3, 60), offPeak: (-64, -64, -116.7, -90, -90, -142.7),
                                safety: safety, ruledOut: ruledOut, endsAtRateChange: endsAtRateChange), now)
    }

    /// Saturday 08:30 in On-Peak: starting now dips into On-Peak, which a cloudy week leaves short.
    static func unsafeNow(ruledOut: Estimator.RuledOut? = nil) -> (comparison: Estimator.Comparison, now: Date) {
        let now = at(32.5)
        return (cycleComparison(now: now, recommendedStart: at(44), costNow: 2.108, recommendedCost: 5.27, savings: 0,
                                onPeak: (5, 5, -19.7, 60, 60, 7.3), offPeak: (-64, -100, -64, -90, -142.7, -90),
                                safety: .nowUnsafe(periodKey: "ON_PEAK"), ruledOut: ruledOut), now)
    }

    static func cycleVerdict(_ comparison: Estimator.Comparison, now: Date, forecast: ForecastAvailability = .ready,
                             profile: LoadProfile = harrisonSunday().car) throws -> SmartShiftVerdict {
        try verdict(SmartShiftPresentation.make(profile: profile, result: .init(comparison: comparison, unavailableReason: nil),
                                                forecast: forecast, refreshUnavailable: false, timing: harrisonSunday().timing,
                                                now: now, billingCycleEnd: cycleEnd, currencyCode: "USD", timeZone: "UTC"))
    }

    @Test func headlineWhenTheSafeStartCostsMoreThanNow() throws {
        let (comparison, now) = Self.unsafeNow()
        let verdict = try Self.cycleVerdict(comparison, now: now)
        #expect(Self.normalized(verdict.headline)
            == "Charge the car at 8:00 PM: about \(Self.money(3.16)) more than now, but it won't leave On-Peak short")
        #expect(verdict.barsCaption == "Added to your bill")
        #expect(verdict.bars.map(\.isRecommended) == [true, false])
        #expect(verdict.percentLess == nil)
    }

    @Test func headlineWhenNoStartIsSafe() throws {
        let (comparison, now) = Self.morningDip(safety: .noSafeStart(periodKey: "ON_PEAK"))
        let verdict = try Self.cycleVerdict(comparison, now: now)
        #expect(Self.normalized(verdict.headline)
            == "Charge the car tomorrow at 8:00 AM: the least risky time, but a cloudy week could still leave On-Peak short")
        #expect(verdict.barsCaption == "Added to your bill")
        #expect(verdict.percentLess == nil)
        #expect(!verdict.headline.contains("cheaper"))
    }

    @Test func headlineWhenNoStartIsSafeAndNowIsLeastRisky() throws {
        let (dip, now) = Self.unsafeNow()
        let comparison = Self.cycleComparison(now: now, recommendedStart: now, costNow: 2.108, recommendedCost: 2.108, savings: 0,
                                              onPeak: (5, -19.7, -19.7, 60, 7.3, 7.3), offPeak: (-64, -64, -64, -90, -90, -90),
                                              safety: .noSafeStart(periodKey: "ON_PEAK"))
        #expect(dip.safety != comparison.safety)
        let verdict = try Self.cycleVerdict(comparison, now: now)
        #expect(verdict.headline == "Charge the car now: the least risky time, but a cloudy week could still leave On-Peak short")
        #expect(verdict.bars.count == 1)
    }

    @Test func whyLineNamesTheProjectedBankALaterStartUses() throws {
        let (comparison, now) = Self.morningDip()
        let verdict = try Self.cycleVerdict(comparison, now: now)
        #expect(Self.normalized(verdict.why)
            == "Starting now runs during Off-Peak, where you have no bank, so it's bought at \(Self.rate(0.10)). "
            + "Tomorrow at 8:00 AM it uses your On-Peak bank, projected at +60 kWh by \(Self.shortDate(Self.cycleEnd)), "
            + "giving up \(Self.rate(0.04)) in credit.")
    }

    @Test func whyLineWhenStartingNowIsUnsafe() throws {
        let (comparison, now) = Self.unsafeNow()
        let verdict = try Self.cycleVerdict(comparison, now: now)
        #expect(Self.normalized(verdict.why)
            == "Starting now would draw on your On-Peak bank, which a cloudy week could leave more than 3 kWh short by "
            + "\(Self.shortDate(comparison.safetyEnd)). At 8:00 PM it's bought at the Off-Peak rate of \(Self.rate(0.10)).")
    }

    @Test func bankNoteGivesTheBillDateProjectionBeforeAndAfterTheCharge() throws {
        let (comparison, now) = Self.morningDip()
        let (timing, _, _, car) = Self.harrisonSunday()
        let breakdowns = SmartShiftPresentation.costBreakdowns(comparison: comparison, profile: car, timing: timing, now: now,
                                                                billingCycleEnd: Self.cycleEnd, currencyCode: "USD", timeZone: "UTC")
        let later = try #require(breakdowns.first)
        // Draws use the bill-date bank, not the chart edge (where On-Peak ends at -19.7).
        #expect(later.lines == [
            CostLine(period: "On-Peak", detail: "52.7 kWh from your bank × \(Self.rate(0.04)) credit", amount: Self.money(2.11)),
        ])
        #expect(later.notes == ["On-Peak bank is +5 now, projecting +60 by \(Self.shortDate(Self.cycleEnd)) (bill date), +7 after this charge."])
    }

    @Test func bankNoteSaysWhenRatesChange() throws {
        let (comparison, now) = Self.morningDip(endsAtRateChange: true)
        let (timing, _, _, car) = Self.harrisonSunday()
        let breakdowns = SmartShiftPresentation.costBreakdowns(comparison: comparison, profile: car, timing: timing, now: now,
                                                                billingCycleEnd: Self.at(24 * 30), currencyCode: "USD", timeZone: "UTC")
        #expect(try #require(breakdowns.first).notes
            == ["On-Peak bank is +5 now, projecting +60 by \(Self.shortDate(Self.cycleEnd)), when rates change, +7 after this charge."])
    }

    @Test func ruledOutLineExplainsARejectedCheaperStart() throws {
        let (comparison, now) = Self.morningDip(ruledOut: .init(start: Self.at(36), cost: 1.5, periodKey: "ON_PEAK"))
        let (timing, _, _, car) = Self.harrisonSunday()
        let note = SmartShiftPresentation.ruledOutNote(comparison: comparison, profile: car, timing: timing, now: now, timeZone: "UTC")
        #expect(note.map(Self.normalized)
            == "Charging tomorrow at 12:00 PM would be cheaper if the sun holds, but a cloudy week could leave On-Peak "
            + "more than 3 kWh short by \(Self.shortDate(comparison.safetyEnd)), so it isn't suggested.")
        let dishes = LoadProfile(id: "dishwasher", name: "Wash the dishes", kind: .appliance, energyKwh: 1.5, durationHours: 2, carSettings: nil)
        #expect(SmartShiftPresentation.ruledOutNote(comparison: comparison, profile: dishes, timing: timing, now: now, timeZone: "UTC")?
            .hasPrefix("Washing ") == true)
        #expect(SmartShiftPresentation.ruledOutNote(comparison: comparison, profile: Self.pump, timing: timing, now: now, timeZone: "UTC")?
            .hasPrefix("Starting ") == true)
        #expect(SmartShiftPresentation.ruledOutNote(comparison: Self.morningDip().comparison, profile: car, timing: timing,
                                                    now: now, timeZone: "UTC") == nil)
    }

    @Test func noForecastNoteFollowsHistory() throws {
        let (dip, now) = Self.morningDip()
        let history = Self.cycleComparison(now: now, recommendedStart: dip.recommendedStart, costNow: dip.costNow,
                                           recommendedCost: dip.recommendedCost, savings: dip.savings,
                                           onPeak: (5, -19.7, 33, 60, 7.3, 60), offPeak: (-64, -64, -116.7, -90, -90, -142.7),
                                           usesHistory: true)
        #expect(try Self.cycleVerdict(history, now: now, forecast: .none).notes == [.connectSolcast(usesHistory: true)])
        #expect(try Self.cycleVerdict(dip, now: now, forecast: .none).notes == [.connectSolcast(usesHistory: false)])
        #expect(SmartShiftPresentation.connectSolcastHistoryNote
            == "Without a solar forecast, banks follow your last four weeks. Connect Solcast to see this week's solar.")
        #expect(SmartShiftPresentation.connectSolcastNote
            == "Without a solar forecast, banks are shown as they stand now. Connect Solcast to see today's solar.")
    }

    // MARK: Projection choice and assumptions

    static func historyContext(asOf: Date, forecastHours: Bool = false) -> Estimator.PlanningContext {
        let slots = stride(from: 0, to: 1440, by: 30).map { minute in
            Estimator.PlanningSlot(localMinute: minute, homeKw: 0.5, batteryNetChargeKw: 0,
                                   gridNetExportKw: (480..<1200).contains(minute) ? 2 : -0.5,
                                   cautiousGridNetExportKw: (480..<1200).contains(minute) ? 1 : -0.5)
        }
        return .init(timeZone: "UTC", slots: slots, asOf: asOf)
    }

    @Test func evaluateUsesHistoryWithoutSolcast() throws {
        let (timing, _, now, car) = Self.harrisonSunday()
        let evaluation = SmartShiftPresentation.evaluate(
            profile: car, now: now, timing: timing, forecast: .none, intervals: nil,
            context: Self.historyContext(asOf: now), balanceSourceTime: now, billingCycleEnd: Self.at(48),
            currencyCode: "USD", timeZone: "UTC")
        let comparison = try #require(evaluation.result.comparison)
        #expect(comparison.usesHistory)
        #expect(comparison.assumptions.contains("Banks follow your last four weeks of grid use through the bill date."))
        #expect(comparison.assumptions.contains("A start that dips into a bank must leave it no more than 3 kWh short after a cloudy week."))
        #expect(evaluation.forecast == ForecastAvailability.none)

        // Without grid history the card still holds banks flat.
        let slots = stride(from: 0, to: 1440, by: 30).map { Estimator.PlanningSlot(localMinute: $0, homeKw: 0.5, batteryNetChargeKw: 0) }
        let flat = SmartShiftPresentation.evaluate(
            profile: car, now: now, timing: timing, forecast: .none, intervals: nil,
            context: .init(timeZone: "UTC", slots: slots, asOf: now), balanceSourceTime: now, billingCycleEnd: Self.at(48),
            currencyCode: "USD", timeZone: "UTC")
        #expect(flat.result.comparison?.usesHistory == false)
        #expect(flat.result.comparison?.assumptions.contains { $0.contains("held at today's observed values") } == true)
    }

    @Test func forecastWithHistoryStatesBothSources() throws {
        let (timing, _, now, car) = Self.harrisonSunday()
        let intervals = (0..<96).map { index in
            SolarForecastInterval(periodStart: Self.at(Double(index) / 2), periodEnd: Self.at(Double(index + 1) / 2), powerKw: 1)
        }
        let evaluation = SmartShiftPresentation.evaluate(
            profile: car, now: now, timing: timing, forecast: .ready, intervals: intervals,
            context: Self.historyContext(asOf: now), balanceSourceTime: now, billingCycleEnd: Self.at(48),
            currencyCode: "USD", timeZone: "UTC")
        let assumptions = try #require(evaluation.result.comparison).assumptions
        #expect(assumptions.contains("Solar follows your Solcast forecast for the next 7 days, then your last four weeks through the bill date."))
        #expect(assumptions.contains("A start that dips into a bank must leave it no more than 3 kWh short after a cloudy week."))
        #expect(assumptions.contains("Typical household and battery behavior follows the historical local-time profile."))
    }
}

extension SmartShiftPresentationTests {
    @Test func unsafeNowWithACheaperSafeStartStillClaimsTheSaving() throws {
        let now = Self.at(32.5)
        let comparison = Self.cycleComparison(now: now, recommendedStart: Self.at(44), costNow: 2.83, recommendedCost: 1.00, savings: 1.83,
                                              onPeak: (1, 1, -9, 1, 1, -9), offPeak: (-20, -30, -20, -20, -30, -20),
                                              safety: .nowUnsafe(periodKey: "ON_PEAK"))
        let verdict = try Self.cycleVerdict(comparison, now: now)
        #expect(Self.normalized(verdict.headline) == "Charge the car at 8:00 PM: about \(Self.money(1.83)) cheaper than now")
        #expect(verdict.barsCaption == "Added to your bill (shorter is better)")
        #expect(verdict.percentLess != nil)
        #expect(verdict.why.hasPrefix("Starting now would draw on your On-Peak bank"))
    }
}

// MARK: - Recompute when the card goes stale

extension SmartShiftPresentationTests {
    @Test func nextRefreshIsTheRecommendedStartWhenItComesFirst() {
        // Recommended at 16:30; the next switch is 16:30 too, then 31:00.
        let comparison = Self.comparison(recommendedStart: Self.at(15))
        #expect(SmartShiftPresentation.nextRefresh(comparison: comparison, now: Self.now) == Self.at(15))
    }

    @Test func nextRefreshIsTheNextRateSwitchOnceTheStartHasPassed() {
        let comparison = Self.comparison(recommendedStart: Self.at(16.5))
        // After the recommended start (and the 16:30 switch), the next switch is at 31:00.
        #expect(SmartShiftPresentation.nextRefresh(comparison: comparison, now: Self.at(17)) == Self.at(31))
    }

    @Test func nextRefreshWhenStartingNowIsTheNextSwitch() {
        let comparison = Self.comparison(costNow: 5, recommendedCost: 5, savings: 0, recommendedStart: Self.now)
        #expect(SmartShiftPresentation.nextRefresh(comparison: comparison, now: Self.now) == Self.at(16.5))
    }

    @Test func nextRefreshIsNilWithoutAComparisonOrAnythingAhead() {
        #expect(SmartShiftPresentation.nextRefresh(comparison: nil, now: Self.now) == nil)
        let comparison = Self.comparison(recommendedStart: Self.at(15))
        #expect(SmartShiftPresentation.nextRefresh(comparison: comparison, now: Self.at(50)) == nil)
    }
}

extension SmartShiftPresentationTests {
    @Test func whyLineWhenNowIsCheapestUsesTheBillDateBank() throws {
        // Off-Peak is empty now but projected to refill to +50 by the bill date, so the
        // 40 kWh run is priced from the bank; the why line must say so, not "full rate".
        let refilling = [Estimator.BalanceLane(periodKey: "Off-Peak", startKwh: 0,
                                               recommended: [.init(date: Self.at(18), kwh: 0), .init(date: Self.horizonEnd, kwh: -40)],
                                               startNow: [.init(date: Self.at(18), kwh: 0), .init(date: Self.horizonEnd, kwh: -40)],
                                               projectedKwh: 50, projectedAfterRecommendedKwh: 10, projectedAfterStartNowKwh: 10)]
        let comparison = Estimator.Comparison(
            costNow: 1.04, recommendedStart: Self.at(18), recommendedEnd: Self.at(22.4), recommendedCost: 1.04, savings: 0,
            bestAlternativeSavings: 0, estimatedSolarContribution: 0, horizonStart: Self.at(18), horizonEnd: Self.horizonEnd,
            evaluatedStarts: [Self.at(18)], assumptions: [], hasUnobservedBalance: false, lanes: refilling, periodSwitches: [])
        let screen = SmartShiftPresentation.make(profile: Self.car, result: .init(comparison: comparison, unavailableReason: nil),
            forecast: .ready, refreshUnavailable: false, timing: Self.timing(), now: Self.at(18),
            billingCycleEnd: Self.at(480), currencyCode: "USD", timeZone: "UTC")
        #expect(try Self.verdict(screen).why == "It's Off-Peak, and your Off-Peak bank covers all of this run.")
    }
}
