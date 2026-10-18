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
        #expect(verdict.notes == [.connectSolcast])
        // Now, each run's end, and each rate-period switch.
        #expect(verdict.axisDates == [Self.now, Self.at(14.4), Self.at(16.5), Self.at(22.4), Self.at(31), Self.at(40.5)])
    }

    @Test func laterStartTomorrowSaysSo() throws {
        let comparison = Self.comparison(recommendedStart: Self.at(40.5))
        let verdict = try Self.verdict(Self.make(result: .init(comparison: comparison, unavailableReason: nil)))
        #expect(Self.normalized(verdict.headline) == "Charge the car at 4:30 PM tomorrow: about \(Self.money(1.89)) cheaper than now")
        #expect(Self.normalized(verdict.why).hasSuffix("Run at 4:30 PM tomorrow to use your Off-Peak bank."))
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
        #expect(none.notes == [.connectSolcast, .unobservedBalance])
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

    @Test func whyLineNamesPeriods() throws {
        let verdict = try Self.verdict(Self.make())
        #expect(Self.normalized(verdict.why) == "Starting now runs during Peak, where you have no bank. Run at 4:30 PM to use your Off-Peak bank.")
    }

    @Test func whyLineNamesEveryBankTheLaterRunUses() throws {
        // 15:00 + 5.9 h runs through the end of Peak and into Off-Peak.
        let verdict = try Self.verdict(Self.make(result: .init(
            comparison: Self.comparison(recommendedStart: Self.at(15)), unavailableReason: nil)))
        #expect(Self.normalized(verdict.why)
            == "Starting now runs during Peak, where you have no bank. Run at 3:00 PM to use your Peak and Off-Peak banks.")
    }

    @Test func whyLineWhenNowIsCheapest() throws {
        let covered = [Self.lane("Off-Peak", start: 50, later: 10, startNow: 10)]
        let partly = [Self.lane("Off-Peak", start: 25, later: 0, startNow: 0)]
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
        // Starting at 05:00 runs from Off-Peak into Peak; the later start stays in Off-Peak.
        let start = Self.at(5)
        let comparison = Estimator.Comparison(
            costNow: 4, recommendedStart: Self.at(16.5), recommendedEnd: Self.at(20.9), recommendedCost: 2, savings: 2,
            bestAlternativeSavings: 2, estimatedSolarContribution: 0, horizonStart: start, horizonEnd: Self.horizonEnd,
            evaluatedStarts: [start], assumptions: [], hasUnobservedBalance: false,
            lanes: [Self.lane("Off-Peak", start: 18, later: 4, startNow: 10), Self.lane("Peak", start: -6, later: -6, startNow: -12)],
            periodSwitches: [Self.at(7)])
        let screen = SmartShiftPresentation.make(profile: Self.car, result: .init(comparison: comparison, unavailableReason: nil),
            forecast: .none, refreshUnavailable: false, timing: Self.timing(), now: start,
            billingCycleEnd: Self.at(480), currencyCode: "USD", timeZone: "UTC")
        #expect(Self.normalized(try Self.verdict(screen).why)
            == "Starting now runs into Peak, where you have no bank. Run at 4:30 PM to stay in your Off-Peak bank.")
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
            profile: Self.car, result: .init(comparison: Self.comparison(lanes: lanes), unavailableReason: nil),
            forecast: .ready, refreshUnavailable: false, timing: Self.rawKeyTiming(), now: Self.now,
            billingCycleEnd: Self.at(480), currencyCode: "USD", timeZone: "UTC")
        let verdict = try Self.verdict(screen)
        #expect(verdict.lanes.map(\.title) == ["On-Peak bank (kWh)", "Off-Peak bank (kWh)"])
        #expect(verdict.why.hasPrefix("Starting now runs during On-Peak,"))
    }

    @Test func runRowsSplitEachBankFromWhatIsBought() {
        // 14 kWh over 5.9 h from 16:30 runs entirely in Off-Peak; that bank ends at +4, so all 14 came from it.
        let pump = LoadProfile(id: UUID().uuidString, name: "Pool pump", kind: .custom, energyKwh: 14, durationHours: 5.9, carSettings: nil)
        let later = SmartShiftPresentation.runRows(comparison: Self.comparison(), profile: pump, timing: Self.timing())
        #expect(later == [RunRow(name: "Off-Peak", fromBank: "14.0 kWh from your bank", bought: "0.0 kWh bought")])

        // Starting now (08:30) runs entirely in Peak, which is owed, so all of it is bought.
        let nowLanes = [Self.lane("Peak", start: -6, later: -20, startNow: -20)]
        let now = Self.comparison(costNow: 5.32, recommendedCost: 5.32, savings: 0, recommendedStart: Self.now, lanes: nowLanes)
        #expect(SmartShiftPresentation.runRows(comparison: now, profile: pump, timing: Self.timing())
            == [RunRow(name: "Peak", fromBank: "0.0 kWh from your bank", bought: "14.0 kWh bought")])

        // A bank that covers part of the run: Off-Peak ends at -2 after drawing 14, so 12 came from the bank.
        let partLanes = [Self.lane("Peak", start: -6, later: -6, startNow: -20), Self.lane("Off-Peak", start: 12, later: -2, startNow: 12)]
        #expect(SmartShiftPresentation.runRows(comparison: Self.comparison(lanes: partLanes), profile: pump, timing: Self.timing())
            == [RunRow(name: "Off-Peak", fromBank: "12.0 kWh from your bank", bought: "2.0 kWh bought")])
    }
}
