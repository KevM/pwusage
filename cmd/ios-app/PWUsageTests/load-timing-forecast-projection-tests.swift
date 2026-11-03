import Foundation
@testable import PWUsage
import Testing

extension LoadTimingForecastEstimatorTests {
    @Test func noCompleteRunWithinHorizonIsUnavailable() {
        let result = evaluate(profile: profile(3, hours: 2), tariffs: [tariff(0, 3600)],
                              forecast: [forecast(0, from: 0, to: 3600)])
        #expect(result.unavailableReason == .noFittingRun)
    }

    @Test func billingCycleBoundaryTruncatesCommonHorizon() throws {
        let result = evaluate(tariffs: [tariff(0, 7200)], forecast: [forecast(0, from: 0, to: 7200)], cycleEnd: 2700)
        #expect(result.unavailableReason == .noFittingRun)
    }

    @Test func incompatibleRateChangeTruncatesHorizon() throws {
        let tariffs = [tariff(0, 3600, buy: 0.3), tariff(3600, 7200, buy: 0.4)]
        let result = try #require(evaluate(tariffs: tariffs, forecast: [forecast(0, from: 0, to: 7200)]).comparison)
        #expect(result.horizonEnd == start.addingTimeInterval(3600))
    }

    @Test func missingHistoricalBalanceSlotIsUnavailable() {
        let result = evaluate(tariffs: [tariff(0, 7200, key: "a")], balances: [:], hasCycleData: false,
                              forecast: [forecast(0, from: 0, to: 7200)])
        #expect(result.unavailableReason == .incompleteBalance)
    }

    @Test func earlyCyclePricesUpcomingPeriodUsingZeroBalance() throws {
        let peak = tariff(0, 3600, key: "Peak", buy: 0.30, sell: 0.05)
        let result = try #require(evaluate(tariffs: [peak], balances: ["Off peak": 4],
                                           pricingBalances: ["Off peak": 4, "Peak": 0],
                                           forecast: [forecast(0, from: 0, to: 3600)]).comparison)
        #expect(abs(result.costNow - 0.90) < 0.000_001)
    }

    @Test func missingUsedPricingPeriodBalanceIsIncompleteEvenWhenCycleDataExists() {
        let result = evaluate(tariffs: [tariff(0, 3600, key: "Peak")], balances: ["Off peak": 4],
                              pricingBalances: [:], hasCycleData: true, forecast: [forecast(0, from: 0, to: 3600)])
        #expect(result.unavailableReason == .incompleteBalance)
    }

    @Test func unusedFutureTariffKeyAfterCommonHorizonNeedsNoBalance() throws {
        let tariffs = [tariff(0, 3600, key: "current"), tariff(3600, 7200, key: "later", buy: .nan)]
        let result = try #require(evaluate(tariffs: tariffs, balances: ["current": 2],
                                           forecast: [forecast(0, from: 0, to: 3600)]).comparison)
        #expect(result.horizonEnd == start.addingTimeInterval(3600))
    }

    @Test func nonfiniteRateWithinCommonHorizonIsInvalid() {
        let result = evaluate(tariffs: [tariff(0, 3600, buy: .nan)], forecast: [forecast(0, from: 0, to: 3600)])
        #expect(result.unavailableReason == .invalidInput)
    }

    @Test func missingContextSlotOutsideSharedHorizonIsIgnored() throws {
        let complete = context()
        let futureOnlyMissing = complete.slots.filter { $0.localMinute != 0 }
        let limited = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC", slots: futureOnlyMissing,
                                                                  asOf: start)
        let result = try #require(evaluate(tariffs: [tariff(0, 3600)], forecast: [forecast(0, from: 0, to: 3600)],
                                           context: limited).comparison)
        #expect(result.horizonEnd == start.addingTimeInterval(3600))
    }

    @Test func nilContextValuesOutsideSharedHorizonAreIgnored() throws {
        let complete = context()
        let slots = complete.slots.map { slot in
            slot.localMinute == 0
                ? LoadTimingForecastEstimator.PlanningSlot(localMinute: slot.localMinute, homeKw: nil,
                                                           batteryNetChargeKw: nil)
                : slot
        }
        let limited = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC", slots: slots, asOf: start)
        #expect(evaluate(tariffs: [tariff(0, 3600)], forecast: [forecast(0, from: 0, to: 3600)],
                         context: limited).comparison != nil)
    }

    @Test func futureContextGapWithNoCompleteRunReturnsNoFittingRun() {
        let complete = context()
        let usedSlotMissing = complete.slots.filter { $0.localMinute != 510 }
        let limited = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC", slots: usedSlotMissing, asOf: start)
        let result = evaluate(tariffs: [tariff(0, 3600)], forecast: [forecast(0, from: 0, to: 3600)], context: limited)
        #expect(result.unavailableReason == .noFittingRun)
    }

    @Test func futureContextGapTruncatesHorizonAndKeepsEarlierRun() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let midpoint = start.addingTimeInterval(4500)
        let localMinute = calendar.component(.hour, from: midpoint) * 60 + calendar.component(.minute, from: midpoint)
        let missingMinute = (localMinute / 30) * 30
        let full = context()
        let futureGap = LoadTimingForecastEstimator.PlanningContext(
            timeZone: "UTC",
            slots: full.slots.filter { $0.localMinute != missingMinute },
            asOf: start
        )
        let result = try #require(evaluate(tariffs: [tariff(0, 7200)], forecast: [forecast(0, from: 0, to: 7200)],
                                           context: futureGap).comparison)
        #expect(result.horizonEnd == start.addingTimeInterval(3600))
        #expect(result.recommendedEnd == start.addingTimeInterval(3600))
    }

    @Test func contextGapAtBalanceSourceRejectsProjection() {
        let full = context()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        let currentMinute = calendar.component(.hour, from: start) * 60 + calendar.component(.minute, from: start)
        let missingMinute = (currentMinute / 30) * 30
        let gap = LoadTimingForecastEstimator.PlanningContext(
            timeZone: "UTC",
            slots: full.slots.filter { $0.localMinute != missingMinute },
            asOf: start
        )
        let result = evaluate(tariffs: [tariff(0, 7200)], forecast: [forecast(0, from: 0, to: 7200)], context: gap)
        #expect(result.unavailableReason == .incompleteContext)
    }

    @Test func finiteInputsWhoseLoadPowerOverflowsAreInvalid() {
        let result = evaluate(profile: profile(1.7e308, hours: 0.5), tariffs: [tariff(0, 3600)],
                              forecast: [forecast(0, from: 0, to: 3600)])
        #expect(result.unavailableReason == .invalidInput)
    }

    @Test func finiteDurationWhoseSecondsOverflowIsInvalid() {
        let result = evaluate(profile: profile(3, hours: 1.7e308), tariffs: [tariff(0, 3600)],
                              forecast: [forecast(0, from: 0, to: 3600)])
        #expect(result.unavailableReason == .invalidInput)
    }

    @Test func overflowingProjectedBaselineBalanceIsInvalidInput() {
        let result = evaluate(tariffs: [tariff(0, 3600)], balances: ["p": Double.greatestFiniteMagnitude],
                              forecast: [forecast(1e308, from: 0, to: 3600)])
        #expect(result.unavailableReason == .invalidInput)
    }

    @Test func overflowingCostRateProductIsInvalidInput() {
        let result = evaluate(tariffs: [tariff(0, 3600, buy: 1e308)], balances: ["p": 0],
                              forecast: [forecast(0, from: 0, to: 3600)])
        #expect(result.unavailableReason == .invalidInput)
    }

    @Test func zeroChargeProfileHasTypedNoChargeResult() {
        let car = LoadProfile(id: "car", name: "Car", kind: .car, energyKwh: 0, durationHours: 0,
                              carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 50,
                                                           targetStateOfCharge: 50, chargingLevel: .level2))
        #expect(evaluate(profile: car, tariffs: [tariff(0, 3600)],
                         forecast: [forecast(0, from: 0, to: 3600)]).unavailableReason == .noEnergyNeeded)
    }

    @Test func profileWallEnergyIsConservedAcrossBoundaries() throws {
        let result = try #require(evaluate(profile: profile(6, hours: 2),
                                           tariffs: [tariff(0, 1800), tariff(1800, 7200)],
                                           balances: ["p": 0], forecast: [forecast(0, from: 0, to: 7200)]).comparison)
        #expect(abs(result.costNow - 1.80) < 0.000_001)
        #expect(result.recommendedEnd == start.addingTimeInterval(7200))
        #expect(result.estimatedSolarContribution == 0)
    }

    @Test func solarContributionSubtractsHomeAndPositiveBatteryCharge() throws {
        let result = try #require(evaluate(profile: profile(3, hours: 1), tariffs: [tariff(0, 3600)],
                                           balances: ["p": 100], forecast: [forecast(5, from: 0, to: 3600)],
                                           context: context(home: 1, battery: 1)).comparison)
        #expect(abs(result.estimatedSolarContribution - 3) < 0.000_001)
    }

    @Test func solarChangesWithinSameNettedPeriodDoNotChangeIncrementalCost() throws {
        let low = try #require(evaluate(tariffs: [tariff(0, 7200)], balances: ["p": 100],
                                        forecast: [forecast(0, from: 0, to: 7200)]).comparison)
        let high = try #require(evaluate(tariffs: [tariff(0, 7200)], balances: ["p": 100],
                                         forecast: [forecast(10, from: 0, to: 7200)]).comparison)
        #expect(abs(low.costNow - high.costNow) < 0.000_001)
    }

    @Test func highExportValueCanMakeSunnyWindowWorse() throws {
        let tariffs = [tariff(0, 3600, key: "sun", buy: 0.30, sell: 0.40),
                       tariff(3600, 7200, key: "night", buy: 0.20, sell: 0.02)]
        let result = try #require(evaluate(tariffs: tariffs, balances: ["sun": 100, "night": 0],
                                           forecast: [forecast(5, from: 0, to: 3600),
                                                      forecast(0, from: 3600, to: 7200)]).comparison)
        #expect(result.recommendedStart == start.addingTimeInterval(3600))
    }

    @Test func tariffTransitionsAndTransitionMinusDurationAreEnumerated() throws {
        let tariffs = [tariff(0, 3600, key: "a", buy: 0.5, sell: 0), tariff(3600, 10800, key: "b", buy: 0.1, sell: 0)]
        let result = try #require(evaluate(profile: profile(1, hours: 1), tariffs: tariffs, balances: ["a": 0, "b": 0],
                                           forecast: [forecast(0, from: 0, to: 10800)]).comparison)
        #expect(result.evaluatedStarts.contains(start.addingTimeInterval(3600)))
        #expect(result.evaluatedStarts.contains(start.addingTimeInterval(0)))
    }

    @Test func zeroMinorUnitSavingsKeepsNowAsRecommendation() throws {
        let result = try #require(evaluate(tariffs: [tariff(0, 7200)], balances: ["p": 0],
                                           forecast: [forecast(0, from: 0, to: 7200)]).comparison)
        #expect(result.recommendedStart == start)
        #expect(result.savings == 0)
    }

    @Test func currencyMinorUnitUsesCurrencyFractionDigits() {
        #expect(LoadTimingForecastEstimator.currencyMinorUnit("USD") == 0.01)
        #expect(LoadTimingForecastEstimator.currencyMinorUnit("JPY") == 1)
    }

    @Test func recommendationThresholdUsesCurrencyMinorUnit() throws {
        let tariffs = [tariff(0, 3600, key: "early", buy: 0.30, sell: 0),
                       tariff(3600, 7200, key: "late", buy: 0.29, sell: 0)]
        let balances: [String: Double] = ["early": 0, "late": 0]
        let forecast = [forecast(0, from: 0, to: 7200)]
        let usd = try #require(evaluate(tariffs: tariffs, balances: balances, forecast: forecast,
                                        currencyCode: "USD").comparison)
        let jpy = try #require(evaluate(tariffs: tariffs, balances: balances, forecast: forecast,
                                        currencyCode: "JPY").comparison)
        #expect(usd.recommendedStart == start.addingTimeInterval(3600))
        #expect(jpy.recommendedStart == start)
    }

    @Test func assumptionsExplainHistoricalBaselineAndEnumeratedSearch() throws {
        let result = try #require(evaluate(tariffs: [tariff(0, 3600)],
                                           forecast: [forecast(0, from: 0, to: 3600)]).comparison)
        #expect(result.assumptions.contains { $0.localizedCaseInsensitiveContains("typical") })
        #expect(result.assumptions.contains { $0.localizedCaseInsensitiveContains("evaluated") })
    }

    @Test func flatProjectionPricesLaterStartFromOffPeakBank() throws {
        let result = evaluateFlat(profile: profile(14, hours: 5.9), now: hours(8.5), tariffs: peakOffPeakTariffs(),
                                  balances: ["Peak": -6, "Off-Peak": 18])
        let comparison = try #require(result.comparison)
        #expect(comparison.recommendedStart == hours(16.5))
        #expect(abs(comparison.costNow - 14 * 0.38) < 0.000_001)
        #expect(abs(comparison.recommendedCost - 14 * 0.26) < 0.000_001)
        #expect(comparison.estimatedSolarContribution == 0)
        #expect(comparison.hasUnobservedBalance == false)
    }

    @Test func flatProjectionAllowsHourOldBalances() throws {
        let now = hours(8.5)
        let source = now.addingTimeInterval(-55 * 60)
        let flat = evaluateFlat(profile: profile(14, hours: 5.9), now: now, tariffs: peakOffPeakTariffs(),
                                balances: ["Peak": -6, "Off-Peak": 18], balanceSource: source)
        #expect(flat.comparison != nil)

        let slots = stride(from: 0, to: 1440, by: 30).map {
            LoadTimingForecastEstimator.PlanningSlot(localMinute: $0, homeKw: 0, batteryNetChargeKw: 0)
        }
        let plan = LoadTimingForecastEstimator.plan(.init(
            now: now,
            timing: timing(peakOffPeakTariffs(), balances: ["Peak": -6, "Off-Peak": 18]),
            projection: .forecast(intervals: [SolarForecastInterval(periodStart: hours(0), periodEnd: hours(48),
                                                                    powerKw: 0)],
                                  context: .init(timeZone: "UTC", slots: slots, asOf: now)),
            balanceSourceTime: source, billingCycleEnd: now.addingTimeInterval(7 * 86_400), currencyCode: "USD"))
        let forecast = LoadTimingForecastEstimator.evaluate(profile: profile(14, hours: 5.9), plan: plan)
        #expect(forecast.unavailableReason == .staleBalance)
    }

    @Test func flatProjectionPricesMissingPeriodAtBuyRate() throws {
        let result = evaluateFlat(profile: profile(14, hours: 5.9), now: hours(8.5), tariffs: peakOffPeakTariffs(),
                                  balances: ["Peak": -6], pricingBalances: ["Peak": -6])
        let comparison = try #require(result.comparison)
        #expect(comparison.hasUnobservedBalance)
        #expect(comparison.recommendedStart == hours(16.5))
        #expect(abs(comparison.recommendedCost - 14 * 0.20) < 0.000_001)
    }

    @Test func flatProjectionFollowsFallBackWallClock() throws {
        // America/Chicago falls back at 02:00 CDT on 2026-11-01 (07:00 UTC), so that day lasts 25 hours.
        let zone = try #require(TimeZone(identifier: "America/Chicago"))
        let formatter = ISO8601DateFormatter()
        let now = try #require(formatter.date(from: "2026-11-01T05:10:00Z")) // 00:10 CDT.
        let switchAt = try #require(formatter.date(from: "2026-11-01T13:00:00Z")) // 07:00 CST.
        let expectedEnd = try #require(formatter.date(from: "2026-11-03T06:00:00Z")) // Midnight CST after Nov 2.
        let segments = [
            LoadTimingTariffSegment(start: now.addingTimeInterval(-3600), end: switchAt, periodKey: "Off-Peak",
                                    name: "Off-Peak", buyRate: 0.20, sellRate: 0.05),
            LoadTimingTariffSegment(start: switchAt, end: expectedEnd.addingTimeInterval(86_400), periodKey: "Peak",
                                    name: "Peak", buyRate: 0.40, sellRate: 0.10)
        ]
        let result = evaluateFlat(profile: profile(2, hours: 1), now: now, tariffs: segments,
                                  balances: ["Off-Peak": 0, "Peak": 0], timeZone: "America/Chicago")
        let comparison = try #require(result.comparison)

        #expect(comparison.horizonEnd == expectedEnd)
        let starts = comparison.evaluatedStarts
        #expect(Set(starts).count == starts.count)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        for start in starts where start != now && start != switchAt {
            #expect(calendar.component(.minute, from: start).isMultiple(of: 30))
            #expect(calendar.component(.second, from: start) == 0)
        }
        // 01:30 happens twice on the wall clock; both instants are evaluated.
        #expect(starts.contains(try #require(formatter.date(from: "2026-11-01T06:30:00Z"))))
        #expect(starts.contains(try #require(formatter.date(from: "2026-11-01T07:30:00Z"))))
    }

    // MARK: - Balance lanes

    @Test func lanesTrackEachPlanAgainstItsBank() throws {
        let now = hours(8.5)
        let comparison = try #require(evaluateFlat(profile: profile(14, hours: 5.9), now: now,
                                                   tariffs: peakOffPeakTariffs(),
                                                   balances: ["Peak": -6, "Off-Peak": 18]).comparison)
        let offPeak = try lane("Off-Peak", in: comparison)
        let peak = try lane("Peak", in: comparison)

        #expect(abs(try #require(offPeak.recommended.last).kwh - (18 - 14)) < 0.000_001)
        #expect(abs(try #require(offPeak.startNow.last).kwh - 18) < 0.000_001)
        #expect(abs(try #require(peak.startNow.last).kwh - (-6 - 14)) < 0.000_001)
        #expect(abs(try #require(peak.recommended.last).kwh - (-6)) < 0.000_001)
        #expect(offPeak.startKwh == 18)
        #expect(peak.startKwh == -6)
        #expect(comparison.periodSwitches.contains(hours(16.5)))
        for series in [offPeak.recommended, offPeak.startNow, peak.recommended, peak.startNow] {
            #expect(series.first?.date == now)
            #expect(series.last?.date == comparison.horizonEnd)
        }
    }

    @Test func lanesShowOnlyTouchedPeriodsAndCurrent() throws {
        // Super Off-Peak 00–06, Off-Peak 06–10, Mid 10–14, Peak 14–20, Off-Peak 20–24, on two days.
        let rates: [String: (buy: Double, sell: Double)] = [
            "Super Off-Peak": (0.40, 0.02), "Off-Peak": (0.30, 0.04), "Mid": (0.35, 0.05), "Peak": (0.50, 0.08)
        ]
        let spans = [HourSpan(0, 6, "Super Off-Peak"), HourSpan(6, 10, "Off-Peak"), HourSpan(10, 14, "Mid"),
                     HourSpan(14, 20, "Peak"), HourSpan(20, 24, "Off-Peak")]
        let segments = try [0.0, 24].flatMap { day in
            try spans.map { span in
                let rate = try #require(rates[span.key])
                return LoadTimingTariffSegment(start: hours(day + span.start), end: hours(day + span.end),
                                               periodKey: span.key, name: span.key,
                                               buyRate: rate.buy, sellRate: rate.sell)
            }
        }
        let comparison = try #require(evaluateFlat(profile: profile(2, hours: 1), now: hours(8), tariffs: segments,
                                                   balances: ["Super Off-Peak": 0, "Off-Peak": 0, "Mid": 10,
                                                              "Peak": 0]).comparison)

        #expect(comparison.recommendedStart == hours(10))
        #expect(comparison.lanes.map(\.periodKey) == ["Off-Peak", "Mid"])
        #expect(comparison.periodSwitches.contains(hours(10)))
        #expect(comparison.periodSwitches.contains(hours(14)))
        #expect(comparison.periodSwitches.contains(hours(30)))
        #expect(comparison.periodSwitches.allSatisfy { $0 > hours(8) && $0 < comparison.horizonEnd })
    }

    @Test func forecastLanesIncludeProjectedSolar() throws {
        // A high Peak export rate makes the Off-Peak bank the cheaper one to spend,
        // so the recommended run never touches Peak, yet Peak still fills from solar.
        let tariffs = peakOffPeakTariffs().map { segment in
            LoadTimingTariffSegment(start: segment.start, end: segment.end, periodKey: segment.periodKey,
                                    name: segment.name,
                                    buyRate: segment.buyRate,
                                    sellRate: segment.periodKey == "Peak" ? 0.40 : segment.sellRate)
        }
        let solar = (0 ..< 96).map { index -> SolarForecastInterval in
            let begin = hours(Double(index) / 2), end = hours(Double(index + 1) / 2)
            let inPeak = tariffs.contains { $0.periodKey == "Peak" && $0.start <= begin && begin < $0.end }
            return SolarForecastInterval(periodStart: begin, periodEnd: end, powerKw: inPeak ? 3 : 0)
        }
        let now = hours(8.5)
        let plan = LoadTimingForecastEstimator.plan(.init(
            now: now,
            timing: timing(tariffs, balances: ["Peak": -6, "Off-Peak": 18]),
            projection: .forecast(intervals: solar, context: context()),
            balanceSourceTime: now, billingCycleEnd: now.addingTimeInterval(7 * 86_400), currencyCode: "USD"))
        let result = LoadTimingForecastEstimator.evaluate(profile: profile(14, hours: 5.9), plan: plan)
        let comparison = try #require(result.comparison)
        #expect(comparison.recommendedStart >= hours(16.5))
        let peak = try lane("Peak", in: comparison)

        #expect(peak.startKwh == -6)
        // 8 hours of 3 kW today (08:30–16:30) and 9.5 hours tomorrow (07:00–16:30).
        #expect(abs(try #require(peak.recommended.last).kwh - (-6 + 3 * 8 + 3 * 9.5)) < 0.000_001)
        #expect(try #require(peak.recommended.last).kwh > peak.startKwh)
    }

    @Test func nowIsCheapestLanesStillShowUntouchedBanks() throws {
        // Spending the Peak bank now forgoes only 0.10/kWh, so starting now wins,
        // and Off-Peak still gets a flat lane so people can see the run skips it.
        let comparison = try #require(evaluateFlat(profile: profile(14, hours: 5.9), now: hours(8.5),
                                                   tariffs: peakOffPeakTariffs(),
                                                   balances: ["Peak": 40, "Off-Peak": 18]).comparison)
        #expect(comparison.recommendedStart == hours(8.5))
        #expect(comparison.lanes.map(\.periodKey) == ["Peak", "Off-Peak"])
        let offPeak = try lane("Off-Peak", in: comparison)
        #expect(offPeak.recommended.allSatisfy { $0.kwh == 18 })
    }
}
