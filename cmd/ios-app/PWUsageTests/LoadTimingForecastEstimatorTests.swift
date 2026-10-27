import Foundation
@testable import PWUsage
import Testing

struct LoadTimingForecastEstimatorTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func profile(_ kwh: Double = 3, hours: Double = 1) -> LoadProfile {
        LoadProfile(id: "load", name: "Load", kind: .appliance, energyKwh: kwh, durationHours: hours, carSettings: nil)
    }

    private func tariff(_ from: TimeInterval, _ to: TimeInterval, key: String = "p", buy: Double = 0.30, sell: Double = 0.05) -> LoadTimingTariffSegment {
        LoadTimingTariffSegment(start: start.addingTimeInterval(from), end: start.addingTimeInterval(to), periodKey: key, name: key, buyRate: buy, sellRate: sell)
    }

    private func timing(_ segments: [LoadTimingTariffSegment], balances: [String: Double] = ["p": 2],
                        pricingBalances: [String: Double]? = nil, hasCycleData: Bool = true) -> LoadTiming {
        let periods = balances.map { key, value in
            LoadTimingPeriod(name: key, marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: value,
                             isActive: false, nextStartPhrase: nil, buyRate: segments.first(where: { $0.periodKey == key })?.buyRate ?? 0.30,
                             sellRate: segments.first(where: { $0.periodKey == key })?.sellRate ?? 0.05)
        }
        let pricing = (pricingBalances ?? balances).map { key, value in
            LoadTimingPeriod(name: key, marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: value,
                             isActive: false, nextStartPhrase: nil, buyRate: segments.first(where: { $0.periodKey == key })?.buyRate ?? 0.30,
                             sellRate: segments.first(where: { $0.periodKey == key })?.sellRate ?? 0.05)
        }
        return LoadTiming(hasTariff: true, hasCycleData: hasCycleData, activeIsCheapest: false, periods: periods,
                          pricingPeriods: pricing, tariffTimeline: segments, nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
    }

    private func forecast(_ power: Double, from: TimeInterval, to: TimeInterval) -> SolarForecastInterval {
        SolarForecastInterval(periodStart: start.addingTimeInterval(from), periodEnd: start.addingTimeInterval(to), powerKw: power)
    }

    private func context(home: Double = 0, battery: Double = 0) -> LoadTimingForecastEstimator.PlanningContext {
        let slots = stride(from: 0, to: 1440, by: 30).map {
            LoadTimingForecastEstimator.PlanningSlot(localMinute: $0, homeKw: home, batteryNetChargeKw: battery)
        }
        return .init(timeZone: "UTC", slots: slots, asOf: start)
    }

    @Test("A tariff season boundary truncates the horizon instead of disabling the comparison")
    func seasonBoundaryTruncatesHorizon() throws {
        // A seasonal tariff: the future season uses different period names, so it
        // has no observed cycle balance yet.
        let segments = [
            tariff(0, 21_600, key: "summer_peak", buy: 0.48, sell: 0.10),
            tariff(21_600, 43_200, key: "summer_offpeak", buy: 0.22, sell: 0.08),
            tariff(43_200, 64_800, key: "winter_peak", buy: 0.52, sell: 0.11),
            tariff(64_800, 86_400, key: "winter_offpeak", buy: 0.20, sell: 0.07),
        ]
        let result = evaluate(
            now: 0,
            tariffs: segments,
            balances: ["summer_peak": 4, "summer_offpeak": 3],
            pricingBalances: ["summer_peak": 4, "summer_offpeak": 3],
            forecast: (0..<48).map { forecast(4, from: TimeInterval($0) * 1800, to: TimeInterval($0 + 1) * 1800) }
        )

        let comparison = try #require(result.comparison, "A season boundary must not disable forecasting")
        // The horizon stops at the first period without an observed balance.
        #expect(comparison.horizonEnd <= start.addingTimeInterval(43_200))
        #expect(comparison.evaluatedStarts.allSatisfy { $0 < start.addingTimeInterval(43_200) })
    }

    @Test("A missing balance for a period already under way still rejects the comparison")
    func missingBalanceInElapsedPeriodRejects() {
        // "q" is already in progress at `now` and has no observed balance, so the
        // baseline cannot be projected at all.
        let segments = [
            tariff(-1800, 21_600, key: "q", buy: 0.30, sell: 0.05),
            tariff(21_600, 43_200, key: "p", buy: 0.30, sell: 0.05),
        ]
        let result = evaluate(
            now: 0,
            tariffs: segments,
            balances: ["p": 2],
            pricingBalances: ["p": 2],
            forecast: (0..<48).map { forecast(4, from: TimeInterval($0) * 1800, to: TimeInterval($0 + 1) * 1800) }
        )

        #expect(result.comparison == nil)
        #expect(result.unavailableReason == .incompleteBalance)
    }

    private func evaluate(
        profile: LoadProfile? = nil,
        now: TimeInterval = 0,
        tariffs: [LoadTimingTariffSegment],
        balances: [String: Double] = ["p": 2],
        pricingBalances: [String: Double]? = nil,
        hasCycleData: Bool = true,
        forecast: [SolarForecastInterval],
        context: LoadTimingForecastEstimator.PlanningContext? = nil,
        balanceSource: TimeInterval = 0,
        cycleEnd: TimeInterval = 172_800,
        currencyCode: String = "USD"
    ) -> LoadTimingForecastEstimator.Result {
        LoadTimingForecastEstimator.evaluate(
            profile: profile ?? self.profile(), now: start.addingTimeInterval(now),
            timing: timing(tariffs, balances: balances, pricingBalances: pricingBalances, hasCycleData: hasCycleData),
            forecast: forecast, context: context ?? self.context(), balanceSourceTime: start.addingTimeInterval(balanceSource),
            billingCycleEnd: start.addingTimeInterval(cycleEnd), currencyCode: currencyCode
        )
    }

    @Test func chargesOnlyIncrementalCostAgainstPositiveObservedBalance() throws {
        let result = try #require(evaluate(tariffs: [tariff(0, 3600)], forecast: [forecast(0, from: 0, to: 3600)]).comparison)
        #expect(abs(result.costNow - 0.40) < 0.000_001)
    }

    @Test func theFinalObservedIntervalIsNotCountedTwice() throws {
        // `balanceSourceTime` is the start of the final observed five-minute
        // interval, so that interval is already inside the cycle balance and
        // must not be projected a second time. The household profile is 1 kW of
        // draw with no solar, and the cycle balance is sized to leave the
        // projected baseline on the export side of zero, so the load crosses the
        // boundary and the baseline's own credit is visible in the result.
        //
        // Projecting the 60 unobserved minutes: 47/24 - 1 = 23/24 kWh of export,
        // which the 3 kWh load turns into 2.04167 kWh of import:
        // 2.04167 * 0.30 + 0.95833 * 0.05 = 0.660417. Re-projecting the 5
        // already-observed minutes as well would leave 0.875 kWh of export and
        // report 0.68125 instead.
        let result = try #require(evaluate(
            now: 0,
            tariffs: [tariff(-300, 3600, buy: 0.30, sell: 0.05)],
            balances: ["p": 47.0 / 24.0],
            forecast: [forecast(0, from: -300, to: 3600)],
            context: context(home: 1),
            balanceSource: -300
        ).comparison)
        #expect(abs(result.costNow - 0.660_416_666_666) < 0.000_001)
    }

    @Test func signedDeficitMakesIncrementalCostNinetyCents() throws {
        let result = try #require(evaluate(tariffs: [tariff(0, 3600)], balances: ["p": -2], forecast: [forecast(0, from: 0, to: 3600)]).comparison)
        #expect(abs(result.costNow - 0.90) < 0.000_001)
    }

    @Test func additionalLoadInSurplusHasForegoneExportCost() throws {
        let result = try #require(evaluate(tariffs: [tariff(0, 3600, sell: 0.12)], balances: ["p": 100], forecast: [forecast(10, from: 0, to: 3600)]).comparison)
        #expect(abs(result.costNow - 0.36) < 0.000_001)
    }

    @Test func finiteZeroAndNegativeRatesAreAccepted() throws {
        let result = try #require(evaluate(tariffs: [tariff(0, 3600, buy: 0, sell: -0.02)], balances: ["p": -2], forecast: [forecast(0, from: 0, to: 3600)]).comparison)
        #expect(result.costNow == 0)
    }

    @Test func repeatedTariffPeriodsShareOneSignedBalance() throws {
        let result = try #require(evaluate(tariffs: [tariff(0, 1800), tariff(1800, 3600)], forecast: [forecast(0, from: 0, to: 3600)]).comparison)
        #expect(abs(result.costNow - 0.40) < 0.000_001)
    }

    @Test func loadRunCrossesRatePeriodsAndUsesExactOverlap() throws {
        let tariffs = [tariff(0, 1800, key: "a", buy: 0.20, sell: 0.04), tariff(1800, 7200, key: "b", buy: 0.50, sell: 0.10)]
        let result = try #require(evaluate(tariffs: tariffs, balances: ["a": 0, "b": 0], forecast: [forecast(0, from: 0, to: 7200)]).comparison)
        #expect(abs(result.costNow - 1.05) < 0.000_001)
        #expect(result.recommendedEnd == start.addingTimeInterval(3600))
    }

    @Test func candidateOrderDoesNotChangeChosenRecommendation() throws {
        let ordered = [forecast(0, from: 0, to: 3600), forecast(0, from: 3600, to: 7200)]
        let reversed = ordered.reversed()
        let a = try #require(evaluate(tariffs: [tariff(0, 7200, buy: 0.3, sell: 0.05)], balances: ["p": 0], forecast: ordered).comparison)
        let b = try #require(evaluate(tariffs: [tariff(0, 7200, buy: 0.3, sell: 0.05)], balances: ["p": 0], forecast: Array(reversed)).comparison)
        #expect(a.recommendedStart == b.recommendedStart)
        #expect(a.recommendedCost == b.recommendedCost)
    }

    @Test func everyCandidateUsesSameHorizon() throws {
        let result = try #require(evaluate(tariffs: [tariff(0, 7200)], balances: ["p": 0], forecast: [forecast(0, from: 0, to: 7200)]).comparison)
        #expect(result.horizonEnd == start.addingTimeInterval(7200))
        #expect(result.evaluatedStarts.contains(start))
        #expect(result.evaluatedStarts.contains(start.addingTimeInterval(1800)))
    }

    @Test func balanceSourceOverlapIsNeverForecastTwice() throws {
        let result = try #require(evaluate(now: 1800, tariffs: [tariff(0, 7200)], balances: ["p": 2],
                                           forecast: [forecast(100, from: 0, to: 1800), forecast(0, from: 1800, to: 7200)], balanceSource: 1800).comparison)
        #expect(result.horizonStart == start.addingTimeInterval(1800))
        #expect(abs(result.costNow - 0.40) < 0.000_001)
    }

    @Test func staleBalanceSourceIsUnavailable() {
        let result = evaluate(tariffs: [tariff(-3600, 7200)], forecast: [forecast(0, from: -3600, to: 7200)], balanceSource: -1801)
        #expect(result.comparison == nil)
        #expect(result.unavailableReason == .staleBalance)
    }

    @Test func sourceToNowProjectionRequiresCompleteBaselineCoverage() {
        let result = evaluate(now: 900, tariffs: [tariff(0, 7200)], forecast: [forecast(0, from: 900, to: 7200)], balanceSource: 0)
        #expect(result.unavailableReason == .incompleteCoverage)
    }

    @Test func sourceToNowProjectionWithinThirtyMinutesWorksWithCompleteCoverage() throws {
        let result = try #require(evaluate(now: 1800, tariffs: [tariff(0, 7200)],
                                           forecast: [forecast(0, from: 0, to: 7200)], balanceSource: 0).comparison)
        #expect(result.horizonStart == start.addingTimeInterval(1800))
        #expect(abs(result.costNow - 0.40) < 0.000_001)
    }

    @Test func forecastGapMakesComparisonUnavailable() {
        let result = evaluate(tariffs: [tariff(0, 7200)], forecast: [forecast(0, from: 0, to: 1800), forecast(0, from: 2700, to: 7200)])
        #expect(result.unavailableReason == .noFittingRun)
    }

    @Test func missingContextSlotMakesComparisonUnavailable() {
        let incomplete = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC",
                                                                     slots: [LoadTimingForecastEstimator.PlanningSlot(localMinute: 0, homeKw: nil, batteryNetChargeKw: 0)], asOf: start)
        let result = evaluate(tariffs: [tariff(0, 3600)], forecast: [forecast(0, from: 0, to: 3600)], context: incomplete)
        #expect(result.unavailableReason == .incompleteContext)
    }

    @Test func forecastArrayCoverageMustBeComplete() {
        let result = evaluate(now: 900, tariffs: [tariff(0, 7200)], forecast: [forecast(0, from: 900, to: 3600)])
        #expect(result.unavailableReason == .incompleteCoverage)
    }

    @Test func localContextMappingHandlesDstByInstant() throws {
        let originalContext = context(home: 1)
        let dstContext = LoadTimingForecastEstimator.PlanningContext(timeZone: "America/Los_Angeles", slots: originalContext.slots, asOf: start)
        let result = try #require(evaluate(tariffs: [tariff(0, 7200)], balances: ["p": 0], forecast: [forecast(2, from: 0, to: 7200)], context: dstContext).comparison)
        #expect(result.horizonEnd == start.addingTimeInterval(7200))
    }

    @Test func springDstGapUsesSiteWallClockHalfHourBoundaries() throws {
        let formatter = ISO8601DateFormatter()
        let dstStart = try #require(formatter.date(from: "2026-03-08T09:00:00Z"))
        let end = dstStart.addingTimeInterval(7200)
        let segment = LoadTimingTariffSegment(start: dstStart, end: end, periodKey: "p", name: "p", buyRate: 0.3, sellRate: 0.05)
        let period = LoadTimingPeriod(name: "p", marginalCost: nil, basis: "cycle-net-export", cycleNetExportKwh: 0,
                                      isActive: false, nextStartPhrase: nil, buyRate: 0.3, sellRate: 0.05)
        let dstTiming = LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: [period],
                                   pricingPeriods: [period], tariffTimeline: [segment], nextCheaper: nil, nextCheaperPhrase: nil, nextStartPhraseByKey: [:])
        let slots = (0..<48).map { LoadTimingForecastEstimator.PlanningSlot(localMinute: $0 * 30, homeKw: 0, batteryNetChargeKw: 0) }
        let dstContext = LoadTimingForecastEstimator.PlanningContext(timeZone: "America/Los_Angeles", slots: slots, asOf: dstStart)
        let result = try #require(LoadTimingForecastEstimator.evaluate(profile: profile(), now: dstStart, timing: dstTiming,
                                                                       forecast: [SolarForecastInterval(periodStart: dstStart, periodEnd: end, powerKw: 0)], context: dstContext,
                                                                       balanceSourceTime: dstStart, billingCycleEnd: dstStart.addingTimeInterval(7200), currencyCode: "USD").comparison)
        #expect(result.evaluatedStarts.contains(dstStart.addingTimeInterval(1800))) // 01:30 local.
        #expect(result.evaluatedStarts.contains(dstStart.addingTimeInterval(3600))) // 03:00 local after the skipped hour.
    }

    @Test func runEndingExactlyAtHorizonIsEligible() throws {
        let result = try #require(evaluate(tariffs: [tariff(0, 3600)], forecast: [forecast(0, from: 0, to: 3600)]).comparison)
        #expect(result.evaluatedStarts.contains(start))
        #expect(result.recommendedEnd == start.addingTimeInterval(3600))
    }

    @Test func noCompleteRunWithinHorizonIsUnavailable() {
        let result = evaluate(profile: profile(3, hours: 2), tariffs: [tariff(0, 3600)], forecast: [forecast(0, from: 0, to: 3600)])
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
                                           pricingBalances: ["Off peak": 4, "Peak": 0], forecast: [forecast(0, from: 0, to: 3600)]).comparison)
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
        let limited = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC", slots: futureOnlyMissing, asOf: start)
        let result = try #require(evaluate(tariffs: [tariff(0, 3600)], forecast: [forecast(0, from: 0, to: 3600)], context: limited).comparison)
        #expect(result.horizonEnd == start.addingTimeInterval(3600))
    }

    @Test func nilContextValuesOutsideSharedHorizonAreIgnored() throws {
        let complete = context()
        let slots = complete.slots.map { slot in
            slot.localMinute == 0
                ? LoadTimingForecastEstimator.PlanningSlot(localMinute: slot.localMinute, homeKw: nil, batteryNetChargeKw: nil)
                : slot
        }
        let limited = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC", slots: slots, asOf: start)
        #expect(evaluate(tariffs: [tariff(0, 3600)], forecast: [forecast(0, from: 0, to: 3600)], context: limited).comparison != nil)
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
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let midpoint = start.addingTimeInterval(4500)
        let localMinute = calendar.component(.hour, from: midpoint) * 60 + calendar.component(.minute, from: midpoint)
        let missingMinute = (localMinute / 30) * 30
        let full = context()
        let futureGap = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC",
                                                                    slots: full.slots.filter { $0.localMinute != missingMinute }, asOf: start)
        let result = try #require(evaluate(tariffs: [tariff(0, 7200)], forecast: [forecast(0, from: 0, to: 7200)],
                                           context: futureGap).comparison)
        #expect(result.horizonEnd == start.addingTimeInterval(3600))
        #expect(result.recommendedEnd == start.addingTimeInterval(3600))
    }

    @Test func contextGapAtBalanceSourceRejectsProjection() {
        let full = context()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let currentMinute = calendar.component(.hour, from: start) * 60 + calendar.component(.minute, from: start)
        let missingMinute = (currentMinute / 30) * 30
        let gap = LoadTimingForecastEstimator.PlanningContext(timeZone: "UTC",
                                                              slots: full.slots.filter { $0.localMinute != missingMinute }, asOf: start)
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
                              carSettings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 50, targetStateOfCharge: 50, chargingLevel: .level2))
        #expect(evaluate(profile: car, tariffs: [tariff(0, 3600)], forecast: [forecast(0, from: 0, to: 3600)]).unavailableReason == .noEnergyNeeded)
    }

    @Test func profileWallEnergyIsConservedAcrossBoundaries() throws {
        let result = try #require(evaluate(profile: profile(6, hours: 2), tariffs: [tariff(0, 1800), tariff(1800, 7200)],
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
        let low = try #require(evaluate(tariffs: [tariff(0, 7200)], balances: ["p": 100], forecast: [forecast(0, from: 0, to: 7200)]).comparison)
        let high = try #require(evaluate(tariffs: [tariff(0, 7200)], balances: ["p": 100], forecast: [forecast(10, from: 0, to: 7200)]).comparison)
        #expect(abs(low.costNow - high.costNow) < 0.000_001)
    }

    @Test func highExportValueCanMakeSunnyWindowWorse() throws {
        let tariffs = [tariff(0, 3600, key: "sun", buy: 0.30, sell: 0.40), tariff(3600, 7200, key: "night", buy: 0.20, sell: 0.02)]
        let result = try #require(evaluate(tariffs: tariffs, balances: ["sun": 100, "night": 0], forecast: [forecast(5, from: 0, to: 3600), forecast(0, from: 3600, to: 7200)]).comparison)
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
        let result = try #require(evaluate(tariffs: [tariff(0, 7200)], balances: ["p": 0], forecast: [forecast(0, from: 0, to: 7200)]).comparison)
        #expect(result.recommendedStart == start)
        #expect(result.savings == 0)
    }

    @Test func currencyMinorUnitUsesCurrencyFractionDigits() {
        #expect(LoadTimingForecastEstimator.currencyMinorUnit("USD") == 0.01)
        #expect(LoadTimingForecastEstimator.currencyMinorUnit("JPY") == 1)
    }

    @Test func recommendationThresholdUsesCurrencyMinorUnit() throws {
        let tariffs = [tariff(0, 3600, key: "early", buy: 0.30, sell: 0), tariff(3600, 7200, key: "late", buy: 0.29, sell: 0)]
        let balances: [String: Double] = ["early": 0, "late": 0]
        let forecast = [forecast(0, from: 0, to: 7200)]
        let usd = try #require(evaluate(tariffs: tariffs, balances: balances, forecast: forecast, currencyCode: "USD").comparison)
        let jpy = try #require(evaluate(tariffs: tariffs, balances: balances, forecast: forecast, currencyCode: "JPY").comparison)
        #expect(usd.recommendedStart == start.addingTimeInterval(3600))
        #expect(jpy.recommendedStart == start)
    }

    @Test func assumptionsExplainHistoricalBaselineAndEnumeratedSearch() throws {
        let result = try #require(evaluate(tariffs: [tariff(0, 3600)], forecast: [forecast(0, from: 0, to: 3600)]).comparison)
        #expect(result.assumptions.contains { $0.localizedCaseInsensitiveContains("typical") })
        #expect(result.assumptions.contains { $0.localizedCaseInsensitiveContains("evaluated") })
    }

    // MARK: - Flat (forecast-free) projection

    /// Local midnight (UTC) on the day of `start`, which is 08:00 UTC.
    private var day0: Date { start.addingTimeInterval(-8 * 3600) }

    private func hours(_ value: Double) -> Date { day0.addingTimeInterval(value * 3600) }

    /// Peak 07:00–16:30 (buy 0.38, sell 0.10), Off-Peak otherwise (buy 0.20, sell 0.26), for two days.
    private func peakOffPeakTariffs() -> [LoadTimingTariffSegment] {
        let peak = (buy: 0.38, sell: 0.10), offPeak = (buy: 0.20, sell: 0.26)
        let spans: [(Double, Double, String)] = [(0, 7, "Off-Peak"), (7, 16.5, "Peak"), (16.5, 31, "Off-Peak"),
                                                 (31, 40.5, "Peak"), (40.5, 48, "Off-Peak")]
        return spans.map { from, to, key in
            let rate = key == "Peak" ? peak : offPeak
            return LoadTimingTariffSegment(start: hours(from), end: hours(to), periodKey: key, name: key,
                                           buyRate: rate.buy, sellRate: rate.sell)
        }
    }

    private func evaluateFlat(
        profile: LoadProfile,
        now: Date,
        tariffs: [LoadTimingTariffSegment],
        balances: [String: Double],
        pricingBalances: [String: Double]? = nil,
        balanceSource: Date? = nil,
        cycleEnd: Date? = nil,
        timeZone: String = "UTC"
    ) -> LoadTimingForecastEstimator.Result {
        LoadTimingForecastEstimator.evaluate(
            profile: profile, now: now,
            timing: timing(tariffs, balances: balances, pricingBalances: pricingBalances),
            projection: .flat(timeZone: timeZone), balanceSourceTime: balanceSource ?? now,
            billingCycleEnd: cycleEnd ?? now.addingTimeInterval(7 * 86_400), currencyCode: "USD"
        )
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
        let forecast = LoadTimingForecastEstimator.evaluate(
            profile: profile(14, hours: 5.9), now: now,
            timing: timing(peakOffPeakTariffs(), balances: ["Peak": -6, "Off-Peak": 18]),
            projection: .forecast(intervals: [SolarForecastInterval(periodStart: hours(0), periodEnd: hours(48), powerKw: 0)],
                                  context: .init(timeZone: "UTC", slots: slots, asOf: now)),
            balanceSourceTime: source, billingCycleEnd: now.addingTimeInterval(7 * 86_400), currencyCode: "USD")
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
                                    name: "Peak", buyRate: 0.40, sellRate: 0.10),
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

    private func lane(_ key: String, in comparison: LoadTimingForecastEstimator.Comparison) throws -> LoadTimingForecastEstimator.BalanceLane {
        try #require(comparison.lanes.first { $0.periodKey == key })
    }

    @Test func lanesTrackEachPlanAgainstItsBank() throws {
        let now = hours(8.5)
        let comparison = try #require(evaluateFlat(profile: profile(14, hours: 5.9), now: now, tariffs: peakOffPeakTariffs(),
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
            "Super Off-Peak": (0.40, 0.02), "Off-Peak": (0.30, 0.04), "Mid": (0.35, 0.05), "Peak": (0.50, 0.08),
        ]
        let spans: [(Double, Double, String)] = [(0, 6, "Super Off-Peak"), (6, 10, "Off-Peak"), (10, 14, "Mid"),
                                                 (14, 20, "Peak"), (20, 24, "Off-Peak")]
        let segments = [0.0, 24].flatMap { day in
            spans.map { from, to, key in
                LoadTimingTariffSegment(start: hours(day + from), end: hours(day + to), periodKey: key, name: key,
                                        buyRate: rates[key]!.buy, sellRate: rates[key]!.sell)
            }
        }
        let comparison = try #require(evaluateFlat(profile: profile(2, hours: 1), now: hours(8), tariffs: segments,
                                                   balances: ["Super Off-Peak": 0, "Off-Peak": 0, "Mid": 10, "Peak": 0]).comparison)

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
            LoadTimingTariffSegment(start: segment.start, end: segment.end, periodKey: segment.periodKey, name: segment.name,
                                    buyRate: segment.buyRate, sellRate: segment.periodKey == "Peak" ? 0.40 : segment.sellRate)
        }
        let solar = (0..<96).map { index -> SolarForecastInterval in
            let from = hours(Double(index) / 2), to = hours(Double(index + 1) / 2)
            let inPeak = tariffs.contains { $0.periodKey == "Peak" && $0.start <= from && from < $0.end }
            return SolarForecastInterval(periodStart: from, periodEnd: to, powerKw: inPeak ? 3 : 0)
        }
        let now = hours(8.5)
        let result = LoadTimingForecastEstimator.evaluate(
            profile: profile(14, hours: 5.9), now: now,
            timing: timing(tariffs, balances: ["Peak": -6, "Off-Peak": 18]),
            projection: .forecast(intervals: solar, context: context()),
            balanceSourceTime: now, billingCycleEnd: now.addingTimeInterval(7 * 86_400), currencyCode: "USD")
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
        let comparison = try #require(evaluateFlat(profile: profile(14, hours: 5.9), now: hours(8.5), tariffs: peakOffPeakTariffs(),
                                                   balances: ["Peak": 40, "Off-Peak": 18]).comparison)
        #expect(comparison.recommendedStart == hours(8.5))
        #expect(comparison.lanes.map(\.periodKey) == ["Peak", "Off-Peak"])
        let offPeak = try lane("Off-Peak", in: comparison)
        #expect(offPeak.recommended.allSatisfy { $0.kwh == 18 })
    }
}

// MARK: - Bill-date projection

extension LoadTimingForecastEstimatorTests {
    private typealias Estimator = LoadTimingForecastEstimator

    /// A planning context whose slots carry grid history (`grid(localMinute)` kW).
    private func historyContext(
        timeZone: String = "UTC",
        home: Double = 0,
        battery: Double = 0,
        grid: (Int) -> Double?,
        cautious: ((Int) -> Double?)? = nil
    ) -> Estimator.PlanningContext {
        let slots = stride(from: 0, to: 1440, by: 30).map { minute in
            Estimator.PlanningSlot(localMinute: minute, homeKw: home, batteryNetChargeKw: battery,
                                   gridNetExportKw: grid(minute), cautiousGridNetExportKw: cautious?(minute))
        }
        return .init(timeZone: timeZone, slots: slots, asOf: start)
    }

    private func evaluate(
        _ projection: Estimator.Projection,
        profile: LoadProfile? = nil,
        now: Date,
        tariffs: [LoadTimingTariffSegment],
        balances: [String: Double],
        cycleEnd: Date
    ) -> Estimator.Result {
        Estimator.evaluate(profile: profile ?? self.profile(), now: now, timing: timing(tariffs, balances: balances),
                           projection: projection, balanceSourceTime: now, billingCycleEnd: cycleEnd, currencyCode: "USD")
    }

    /// Daily UTC segments from 00:00 on `start`'s day: On-Peak 08:00–20:00 on
    /// days `onPeakDay(dayIndex)` allows, Off-Peak otherwise.
    private func dailyTariffs(days: Int, onBuy: Double = 0.31, onSell: Double = 0.04, offBuy: Double = 0.10,
                              offSell: Double = 0.03, onPeakDay: (Int) -> Bool = { _ in true }) -> [LoadTimingTariffSegment] {
        let dayZero = start.addingTimeInterval(-8 * 3600)
        func segment(_ day: Int, _ from: Double, _ to: Double, _ key: String) -> LoadTimingTariffSegment {
            let base = dayZero.addingTimeInterval(Double(day) * 86_400)
            let on = key == "ON_PEAK"
            return LoadTimingTariffSegment(start: base.addingTimeInterval(from * 3600), end: base.addingTimeInterval(to * 3600),
                                           periodKey: key, name: on ? "On-Peak" : "Off-Peak",
                                           buyRate: on ? onBuy : offBuy, sellRate: on ? onSell : offSell)
        }
        return (0..<days).flatMap { day in
            onPeakDay(day)
                ? [segment(day, 0, 8, "OFF_PEAK"), segment(day, 8, 20, "ON_PEAK"), segment(day, 20, 24, "OFF_PEAK")]
                : [segment(day, 0, 24, "OFF_PEAK")]
        }
    }

    private static func isDaylight(_ minute: Int) -> Bool { minute >= 480 && minute < 1200 }

    @Test("historyProjectsBanksToTheBillDate")
    func historyProjectsBanksToTheBillDate() throws {
        // `start` is 08:00 UTC; ten days of tariff from midnight cover the cycle.
        let cycleEnd = start.addingTimeInterval(10 * 86_400)
        let context = historyContext { Self.isDaylight($0) ? 2 : -0.5 }
        let result = evaluate(.history(context: context), now: start, tariffs: dailyTariffs(days: 11),
                              balances: ["ON_PEAK": 2, "OFF_PEAK": -10], cycleEnd: cycleEnd)

        let comparison = try #require(result.comparison)
        #expect(comparison.projectionEnd == cycleEnd)
        #expect(!comparison.projectionEndsAtRateChange)
        // Search and chart still end at midnight tomorrow.
        #expect(comparison.horizonEnd == start.addingTimeInterval(40 * 3600))
        let onPeak = try #require(comparison.lanes.first { $0.periodKey == "ON_PEAK" })
        let offPeak = try #require(comparison.lanes.first { $0.periodKey == "OFF_PEAK" })
        // Ten days hold 120 On-Peak hours and 120 Off-Peak hours.
        #expect(abs(onPeak.projectedKwh - (2 + 2 * 120)) < 1e-9)
        #expect(abs(offPeak.projectedKwh - (-10 - 0.5 * 120)) < 1e-9)
    }

    @Test("forecastWindowThenHistory")
    func forecastWindowThenHistory() throws {
        // Two days of 3 kW solar against 1 kW home, then history's 0.5 kW, to a cycle end five days out.
        let cycleEnd = start.addingTimeInterval(5 * 86_400)
        let intervals = (0..<96).map { forecast(3, from: TimeInterval($0) * 1800, to: TimeInterval($0 + 1) * 1800) }
        let context = historyContext(home: 1, grid: { _ in 0.5 })
        let result = evaluate(.forecast(intervals: intervals, context: context), now: start,
                              tariffs: [tariff(0, 5 * 86_400)], balances: ["p": 2], cycleEnd: cycleEnd)

        let comparison = try #require(result.comparison)
        #expect(comparison.projectionEnd == cycleEnd)
        let lane = try #require(comparison.lanes.first { $0.periodKey == "p" })
        #expect(abs(lane.projectedKwh - (2 + 2 * 48 + 0.5 * 72)) < 1e-9)
    }

    @Test("A forecast without grid history still ends at the forecast and midnight tomorrow")
    func forecastWithoutHistoryKeepsTodaysHorizon() throws {
        let intervals = (0..<240).map { forecast(3, from: TimeInterval($0) * 1800, to: TimeInterval($0 + 1) * 1800) }
        let result = evaluate(.forecast(intervals: intervals, context: context(home: 1)), now: start,
                              tariffs: [tariff(0, 5 * 86_400)], balances: ["p": 2], cycleEnd: start.addingTimeInterval(5 * 86_400))

        let comparison = try #require(result.comparison)
        #expect(comparison.projectionEnd == start.addingTimeInterval(40 * 3600))
        #expect(comparison.horizonEnd == comparison.projectionEnd)
        let lane = try #require(comparison.lanes.first { $0.periodKey == "p" })
        #expect(abs(lane.projectedKwh - (2 + 2 * 40)) < 1e-9)
    }

    @Test("overdrawnBankRecoversByBillDate")
    func overdrawnBankRecoversByBillDate() throws {
        // Sunday 10:00 UTC. Weekdays have On-Peak 08:00–20:00; weekends are all Off-Peak.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let dayZero = start.addingTimeInterval(-8 * 3600)
        let weekday = { (day: Int) -> Bool in
            !calendar.isDateInWeekend(dayZero.addingTimeInterval(Double(day) * 86_400))
        }
        let sunday = try #require((0..<7).first { calendar.component(.weekday, from: dayZero.addingTimeInterval(Double($0) * 86_400)) == 1 })
        let now = dayZero.addingTimeInterval(Double(sunday) * 86_400 + 10 * 3600)
        let cycleEnd = now.addingTimeInterval(23 * 86_400)
        let car = LoadProfile(id: "car", name: "Charge the car", kind: .appliance, energyKwh: 52.7,
                              durationHours: 52.7 / 9, carSettings: nil)
        // Daylight exports 3 kW; nights import 2 kW.
        let context = historyContext { Self.isDaylight($0) ? 3 : -2 }
        let result = evaluate(.history(context: context), profile: car, now: now,
                              tariffs: dailyTariffs(days: sunday + 25, onPeakDay: weekday),
                              balances: ["ON_PEAK": 5, "OFF_PEAK": -64], cycleEnd: cycleEnd)

        let comparison = try #require(result.comparison)
        let monday = dayZero.addingTimeInterval(Double(sunday + 1) * 86_400)
        #expect(comparison.recommendedStart >= monday.addingTimeInterval(8 * 3600))
        #expect(comparison.recommendedEnd <= monday.addingTimeInterval(20 * 3600))
        #expect(abs(comparison.recommendedCost - 52.7 * 0.04) < 1e-6)
        let onPeak = try #require(comparison.lanes.first { $0.periodKey == "ON_PEAK" })
        #expect(abs(onPeak.projectedAfterRecommendedKwh - (onPeak.projectedKwh - 52.7)) < 1e-6)
        #expect(onPeak.projectedAfterRecommendedKwh > 0)
    }

    @Test("runsMayFinishAfterTheSearchWindow")
    func runsMayFinishAfterTheSearchWindow() throws {
        // Midnight tomorrow is start + 40 h. Cheap "q" begins at 20:00 tomorrow (start + 36 h).
        let profile = LoadProfile(id: "pump", name: "Pump", kind: .appliance, energyKwh: 6, durationHours: 6, carSettings: nil)
        let tariffs = [tariff(0, 129_600, key: "p", buy: 0.30, sell: 0.05), tariff(129_600, 432_000, key: "q", buy: 0.05, sell: 0.01)]
        let result = evaluate(.flat(timeZone: "UTC"), profile: profile, now: start, tariffs: tariffs,
                              balances: ["p": -10, "q": -10], cycleEnd: start.addingTimeInterval(432_000))

        let comparison = try #require(result.comparison)
        let twentyTomorrow = start.addingTimeInterval(129_600)
        #expect(comparison.horizonEnd == start.addingTimeInterval(144_000))
        #expect(comparison.evaluatedStarts.contains(twentyTomorrow))
        #expect(comparison.recommendedStart == twentyTomorrow)
        #expect(comparison.recommendedEnd > comparison.horizonEnd)
        #expect(comparison.evaluatedStarts.allSatisfy { $0 < comparison.horizonEnd })
    }

    @Test("A run must still finish by the bill date")
    func runsMustFinishByTheBillDate() throws {
        let profile = LoadProfile(id: "pump", name: "Pump", kind: .appliance, energyKwh: 6, durationHours: 6, carSettings: nil)
        let tariffs = [tariff(0, 129_600, key: "p", buy: 0.30, sell: 0.05), tariff(129_600, 432_000, key: "q", buy: 0.05, sell: 0.01)]
        let cycleEnd = start.addingTimeInterval(140_000)
        let result = evaluate(.flat(timeZone: "UTC"), profile: profile, now: start, tariffs: tariffs,
                              balances: ["p": -10, "q": -10], cycleEnd: cycleEnd)

        let comparison = try #require(result.comparison)
        #expect(comparison.recommendedEnd <= cycleEnd)
        #expect(comparison.evaluatedStarts.allSatisfy { $0.addingTimeInterval(6 * 3600) <= cycleEnd })
    }

    @Test("rateChangeEndsProjection")
    func rateChangeEndsProjection() throws {
        let tariffs = [tariff(0, 5 * 86_400, key: "p", buy: 0.30, sell: 0.05), tariff(5 * 86_400, 10 * 86_400, key: "p", buy: 0.40, sell: 0.05)]
        let result = evaluate(.history(context: historyContext { _ in 0.5 }), now: start, tariffs: tariffs,
                              balances: ["p": 2], cycleEnd: start.addingTimeInterval(10 * 86_400))

        let comparison = try #require(result.comparison)
        #expect(comparison.projectionEnd == start.addingTimeInterval(5 * 86_400))
        #expect(comparison.projectionEndsAtRateChange)
        let lane = try #require(comparison.lanes.first { $0.periodKey == "p" })
        #expect(abs(lane.projectedKwh - (2 + 0.5 * 120)) < 1e-9)
    }

    @Test("historyFillFollowsFallBack")
    func historyFillFollowsFallBack() throws {
        // Noon CDT on 2026-10-31 to midnight CST on 2026-11-02: 12 + 25 hours.
        let now = try #require(ISO8601DateFormatter().date(from: "2026-10-31T17:00:00Z"))
        let cycleEnd = try #require(ISO8601DateFormatter().date(from: "2026-11-02T06:00:00Z"))
        let tariffs = [LoadTimingTariffSegment(start: now, end: cycleEnd, periodKey: "p", name: "p", buyRate: 0.3, sellRate: 0.05)]
        let context = historyContext(timeZone: "America/Chicago", grid: { _ in 1 })
        let result = evaluate(.history(context: context), now: now, tariffs: tariffs, balances: ["p": 2], cycleEnd: cycleEnd)

        let comparison = try #require(result.comparison)
        #expect(comparison.projectionEnd == cycleEnd)
        let lane = try #require(comparison.lanes.first { $0.periodKey == "p" })
        #expect(abs(lane.projectedKwh - (2 + 37)) < 1e-9)
    }
}

// MARK: - Cautious projection and the safety rule

extension LoadTimingForecastEstimatorTests {
    /// Half-hour intervals over [0, hours) from `start`, typical and cautious kW by hour offset.
    private func halfHourForecast(hours: Int, typical: (Double) -> Double, cautious: ((Double) -> Double?)?) -> [SolarForecastInterval] {
        (0..<(hours * 2)).map { index in
            let hour = Double(index) / 2
            return SolarForecastInterval(periodStart: start.addingTimeInterval(hour * 3600),
                                         periodEnd: start.addingTimeInterval((hour + 0.5) * 3600),
                                         powerKw: typical(hour), cautiousPowerKw: cautious?(hour))
        }
    }

    private func safetyEvaluate(
        forecast: [SolarForecastInterval],
        tariffs: [LoadTimingTariffSegment],
        balances: [String: Double],
        profile: LoadProfile,
        home: Double = 0
    ) -> LoadTimingForecastEstimator.Result {
        LoadTimingForecastEstimator.evaluate(profile: profile, now: start, timing: timing(tariffs, balances: balances),
                                             // Zero grid history: the rule applies only when history is served.
                                             projection: .forecast(intervals: forecast, context: historyContext(home: home, grid: { _ in 0 })),
                                             balanceSourceTime: start, billingCycleEnd: start.addingTimeInterval(20 * 86_400),
                                             currencyCode: "USD")
    }

    private func load(_ kwh: Double, hours: Double) -> LoadProfile {
        LoadProfile(id: "job", name: "Job", kind: .appliance, energyKwh: kwh, durationHours: hours, carSettings: nil)
    }

    @Test("cautiousSafetyRulesOutADipACloudyWeekWouldSink")
    func cautiousSafetyRulesOutADipACloudyWeekWouldSink() throws {
        let tariffs = [tariff(0, 14_400, key: "OFF", buy: 0.10, sell: 0.03), tariff(14_400, 57_600, key: "ON", buy: 0.31, sell: 0.04),
                       tariff(57_600, 100_800, key: "OFF", buy: 0.10, sell: 0.03), tariff(100_800, 144_000, key: "ON", buy: 0.31, sell: 0.04)]
        // Median solar of 4 kW against a 3.5 kW home banks 12 kWh across both On-Peaks;
        // a cloudy week (each interval 20% toward pv_estimate10 = 0) leaves it 7.2 short.
        let onPeak = { (hour: Double) in (4..<16).contains(hour) || (28..<40).contains(hour) }
        let forecast = halfHourForecast(hours: 40, typical: { onPeak($0) ? 4 : 0 }, cautious: { _ in 0 })
        // 8 kWh in an hour: even a run straddling into On-Peak leaves it 11.2 short.
        let result = safetyEvaluate(forecast: forecast, tariffs: tariffs, balances: ["ON": 0, "OFF": -20], profile: load(8, hours: 1),
                                    home: 3.5)

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .nowSafe)
        #expect(comparison.recommendedStart == start)
        #expect(abs(comparison.recommendedCost - 0.80) < 1e-9)
        let ruledOut = try #require(comparison.ruledOut)
        #expect(ruledOut.start == start.addingTimeInterval(14_400))
        #expect(ruledOut.periodKey == "ON")
        #expect(abs(ruledOut.cost - 0.32) < 1e-9)
    }

    @Test("nowIsCheckedToo")
    func nowIsCheckedToo() throws {
        let tariffs = [tariff(0, 43_200, key: "ON_PEAK", buy: 0.31, sell: 0.04), tariff(43_200, 144_000, key: "OFF_PEAK", buy: 0.10, sell: 0.03)]
        // 2 kW of solar against a 1.2 kW home banks 1 + 0.8 × 12 = 10.6 by the end of On-Peak,
        // enough for a 10 kWh half-hour run; a cloudy week banks 1 + 0.4 × 12 = 5.8, so
        // starting now leaves it 4.2 short.
        let forecast = halfHourForecast(hours: 40, typical: { $0 < 12 ? 2 : 0 }, cautious: { _ in 0 })
        let result = safetyEvaluate(forecast: forecast, tariffs: tariffs, balances: ["ON_PEAK": 1, "OFF_PEAK": -20],
                                    profile: load(10, hours: 0.5), home: 1.2)

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .nowUnsafe(periodKey: "ON_PEAK"))
        #expect(abs(comparison.costNow - 0.40) < 1e-9)
        #expect(comparison.recommendedCost > comparison.costNow)
        #expect(comparison.recommendedStart >= start.addingTimeInterval(43_200))
        #expect(comparison.savings == 0)
    }

    @Test("noSafeStartPicksSmallestShortfall")
    func noSafeStartPicksSmallestShortfall() throws {
        // Half-hour runs never straddle the 20 h switch. 10 kW of solar for 9 h against a
        // 3.8 kW home banks 14 kWh in each period. A cloudy week keeps A's first hour, so
        // it nets 74 − 76 = −2 and B 72 − 76 = −4: an 8 kWh run leaves A 10 short, B 12.
        let tariffs = [tariff(0, 72_000, key: "A", buy: 0.31, sell: 0.06), tariff(72_000, 144_000, key: "B", buy: 0.31, sell: 0.04)]
        let forecast = halfHourForecast(hours: 40,
                                        typical: { $0 < 9 || (20..<29).contains($0) ? 10 : 0 },
                                        cautious: { $0 < 1 ? 10 : 0 })
        let result = safetyEvaluate(forecast: forecast, tariffs: tariffs, balances: ["A": 0, "B": 0], profile: load(8, hours: 0.5),
                                    home: 3.8)

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .noSafeStart(periodKey: "A"))
        #expect(comparison.recommendedStart == start)
        #expect(comparison.ruledOut?.start == start.addingTimeInterval(72_000))
        #expect(comparison.ruledOut?.periodKey == "B")
    }

    @Test("shortfallOfThreeIsAllowed")
    func shortfallOfThreeIsAllowed() throws {
        // One 48 kW half hour banks 24 kWh; a cloudy week banks 24 × (1 − w). The balance
        // is set so a 6 kWh run leaves the cautious bank exactly 3 short (and 0.01 more).
        let tariffs = [tariff(0, 144_000, key: "P", buy: 0.31, sell: 0.04)]
        let forecast = halfHourForecast(hours: 40, typical: { $0 < 0.5 ? 48 : 0 }, cautious: { _ in 0 })
        let atThree = 3 - 24 * (1 - LoadTimingForecastEstimator.forecastCautiousWeight)
        func safety(balance: Double) throws -> LoadTimingForecastEstimator.Safety {
            let result = safetyEvaluate(forecast: forecast, tariffs: tariffs, balances: ["P": balance], profile: load(6, hours: 0.5))
            return try #require(result.comparison).safety
        }
        #expect(try safety(balance: atThree) == .nowSafe)                        // −3.00
        #expect(try safety(balance: atThree - 0.01) == .noSafeStart(periodKey: "P"))  // −3.01
    }

    @Test("boughtPeriodsAreNotChecked")
    func boughtPeriodsAreNotChecked() throws {
        let tariffs = [tariff(0, 144_000, key: "OFF", buy: 0.10, sell: 0.03)]
        let forecast = halfHourForecast(hours: 40, typical: { _ in 0 }, cautious: { _ in 0 })
        let result = safetyEvaluate(forecast: forecast, tariffs: tariffs, balances: ["OFF": -20], profile: load(6, hours: 1))

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .nowSafe)
        #expect(comparison.ruledOut == nil)
    }

    @Test("missingCautiousSolarUsesMedian")
    func missingCautiousSolarUsesMedian() throws {
        let tariffs = [tariff(0, 144_000, key: "P", buy: 0.31, sell: 0.04)]
        let forecast = halfHourForecast(hours: 40, typical: { $0 < 10 ? 2 : 0 }, cautious: nil)
        let result = safetyEvaluate(forecast: forecast, tariffs: tariffs, balances: ["P": 0], profile: load(6, hours: 1))

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .nowSafe)
        #expect(comparison.ruledOut == nil)
    }

    @Test("safetyWindowEndsAtBillDateWhenSooner")
    func safetyWindowEndsAtBillDateWhenSooner() throws {
        let tariffs = dailyTariffs(days: 12)
        let context = historyContext { Self.isDaylight($0) ? 2 : -0.5 }
        func safetyEnd(cycleDays: Double) throws -> Date {
            let result = evaluate(.history(context: context), now: start, tariffs: tariffs,
                                  balances: ["ON_PEAK": 2, "OFF_PEAK": -10], cycleEnd: start.addingTimeInterval(cycleDays * 86_400))
            return try #require(result.comparison).safetyEnd
        }
        #expect(try safetyEnd(cycleDays: 3) == start.addingTimeInterval(3 * 86_400))
        #expect(try safetyEnd(cycleDays: 10) == start.addingTimeInterval(7 * 86_400))
    }

    @Test("History after the safety window cannot make a start pass")
    func historyBeyondTheSafetyWindowCannotRescueAStart() throws {
        // Typical history banks plenty in On-Peak over 20 days; the dull day imports
        // so heavily that even a 1-in-4 week (3 − 13/√7 ≈ −1.9 kW) loses On-Peak, so a
        // 6 kWh dip leaves it short at the seven-day mark.
        let context = historyContext(grid: { Self.isDaylight($0) ? 3 : 0 }, cautious: { Self.isDaylight($0) ? -10 : 0 })
        let result = evaluate(.history(context: context), profile: load(6, hours: 1), now: start, tariffs: dailyTariffs(days: 22),
                              balances: ["ON_PEAK": 0, "OFF_PEAK": -10], cycleEnd: start.addingTimeInterval(20 * 86_400))

        let comparison = try #require(result.comparison)
        // `start` is 08:00, inside On-Peak: starting now dips into it.
        #expect(comparison.safety == .nowUnsafe(periodKey: "ON_PEAK"))
        #expect(comparison.ruledOut?.periodKey == "ON_PEAK")
    }
}

// MARK: - Review fixes

extension LoadTimingForecastEstimatorTests {
    @Test("An overdraw already priced at the buy rate does not fail the safety rule")
    func overdrawAlreadyPricedIsNotPenalised() throws {
        // Off-Peak has 2 kWh banked; a 30 kWh charge buys the other 28 at 10¢ whatever the weather.
        let tariffs = [tariff(0, 43_200, key: "OFF", buy: 0.10, sell: 0.03), tariff(43_200, 144_000, key: "ON", buy: 0.31, sell: 0.04)]
        let result = evaluate(.flat(timeZone: "UTC"), profile: LoadProfile(id: "car", name: "Car", kind: .appliance, energyKwh: 30,
                                                                           durationHours: 3, carSettings: nil),
                              now: start, tariffs: tariffs, balances: ["OFF": 2, "ON": -20], cycleEnd: start.addingTimeInterval(144_000))

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .nowSafe)
        #expect(comparison.recommendedStart == start)
        #expect(abs(comparison.costNow - (2 * 0.03 + 28 * 0.10)) < 1e-9)
    }

    @Test("A forecast that misses the start of the projection is not used with history")
    func forecastMustCoverTheProjectionStart() {
        // The batch starts half an hour after now; history must not silently stand in under the forecast label.
        let intervals = (1..<96).map { forecast(3, from: TimeInterval($0) * 1800, to: TimeInterval($0 + 1) * 1800) }
        let result = evaluate(.forecast(intervals: intervals, context: historyContext(home: 1, grid: { _ in 0.5 })), now: start,
                              tariffs: [tariff(0, 5 * 86_400)], balances: ["p": 2], cycleEnd: start.addingTimeInterval(5 * 86_400))

        #expect(result.comparison == nil)
        #expect(result.unavailableReason == .incompleteCoverage)
    }
}

// MARK: - Older server (no grid history)

extension LoadTimingForecastEstimatorTests {
    @Test("Against a server without grid history, Smart Shift keeps today's recommendation")
    func olderServerKeepsTodaysRecommendation() throws {
        // Harrison's Sunday: Off-Peak owed, On-Peak +5. Monday's median solar lifts On-Peak to +33 by
        // midnight; a cloudy Monday (pv_estimate10) adds nothing. Without history the projection ends at
        // midnight tomorrow, so before the bill-date projection the answer was 4:30 PM tomorrow ($3.38).
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let dayZero = start.addingTimeInterval(-8 * 3600)
        let sunday = try #require((0..<7).first { calendar.component(.weekday, from: dayZero.addingTimeInterval(Double($0) * 86_400)) == 1 })
        let sundayStart = dayZero.addingTimeInterval(Double(sunday) * 86_400)
        let now = sundayStart.addingTimeInterval(13.2 * 3600)
        let mondayStart = sundayStart.addingTimeInterval(86_400)
        let intervals = (0..<((48 - 13) * 2)).map { index -> SolarForecastInterval in
            let periodStart = sundayStart.addingTimeInterval(13 * 3600 + Double(index) * 1800)
            let hour = periodStart.timeIntervalSince(mondayStart) / 3600
            let onPeakDaylight = (8..<20).contains(hour)
            return SolarForecastInterval(periodStart: periodStart, periodEnd: periodStart.addingTimeInterval(1800),
                                         powerKw: onPeakDaylight ? 1 + 28.0 / 12 : 0, cautiousPowerKw: onPeakDaylight ? 1 : 0)
        }
        let weekday = { (day: Int) in !calendar.isDateInWeekend(dayZero.addingTimeInterval(Double(day) * 86_400)) }
        let car = LoadProfile(id: "car", name: "Charge the car", kind: .appliance, energyKwh: 52.7, durationHours: 52.7 / 9, carSettings: nil)
        let result = evaluate(.forecast(intervals: intervals, context: context(home: 1)), profile: car, now: now,
                              tariffs: dailyTariffs(days: sunday + 25, onPeakDay: weekday),
                              balances: ["ON_PEAK": 5, "OFF_PEAK": -64], cycleEnd: now.addingTimeInterval(23 * 86_400))

        let comparison = try #require(result.comparison)
        #expect(comparison.recommendedStart == mondayStart.addingTimeInterval(16.5 * 3600))
        #expect(abs(comparison.recommendedCost - (31.5 * 0.04 + 21.2 * 0.10)) < 1e-6)
    }
}

// MARK: - Device report, 2026-10-18 (Harrison)

extension LoadTimingForecastEstimatorTests {
    @Test("Equally cheap starts go to the earliest despite floating-point noise")
    func equallyCheapStartsGoToTheEarliest() throws {
        // Sunday 17:39 UTC; Monday On-Peak 08:00–20:00 banks plenty, Off-Peak is owed.
        // The car (73 kWh, 15→80%) costs 52.7 kWh × 4¢ at any start that fits in On-Peak.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let dayZero = start.addingTimeInterval(-8 * 3600)
        let sunday = try #require((0..<7).first { calendar.component(.weekday, from: dayZero.addingTimeInterval(Double($0) * 86_400)) == 1 })
        let now = dayZero.addingTimeInterval(Double(sunday) * 86_400 + 17 * 3600 + 39 * 60 + 41.869)
        let monday = dayZero.addingTimeInterval(Double(sunday + 1) * 86_400)
        let car = LoadProfile(id: "car", name: "Charge the car", kind: .car, energyKwh: 36, durationHours: 4,
                              carSettings: CarLoadSettings(capacityKwh: 73, initialStateOfCharge: 15, targetStateOfCharge: 80,
                                                           chargingLevel: .level2))
        let weekday = { (day: Int) in !calendar.isDateInWeekend(dayZero.addingTimeInterval(Double(day) * 86_400)) }
        let context = historyContext { Self.isDaylight($0) ? 1.7 : -0.8 }
        let result = evaluate(.history(context: context), profile: car, now: now,
                              tariffs: dailyTariffs(days: sunday + 25, onPeakDay: weekday),
                              balances: ["ON_PEAK": 4.615, "OFF_PEAK": -54.653], cycleEnd: now.addingTimeInterval(23 * 86_400))

        let comparison = try #require(result.comparison)
        #expect(comparison.recommendedStart == monday.addingTimeInterval(8 * 3600))

        // With a dull day that imports in On-Peak, every On-Peak start fails; the
        // ruled-out start must still be the earliest of the equally cheap ones.
        let dull = historyContext(grid: { Self.isDaylight($0) ? 1.7 : -0.8 }, cautious: { Self.isDaylight($0) ? -8 : -0.8 })
        let rejected = try #require(evaluate(.history(context: dull), profile: car, now: now,
                                             tariffs: dailyTariffs(days: sunday + 25, onPeakDay: weekday),
                                             balances: ["ON_PEAK": 4.615, "OFF_PEAK": -54.653],
                                             cycleEnd: now.addingTimeInterval(23 * 86_400)).comparison)
        #expect(rejected.ruledOut?.start == monday.addingTimeInterval(8 * 3600))
    }
}

// MARK: - Cautious history is a 1-in-4 week

extension LoadTimingForecastEstimatorTests {
    @Test("The cloudy week pulls each typical day toward the dull day by 1/√7, not seven dull days")
    func cautiousHistoryIsAOneInFourWeek() throws {
        // On-Peak exports 2 kW on a typical day and imports 1 kW on the dull day. Seven dull
        // days would leave On-Peak about 84 kWh short; a 1-in-4 week still banks
        // 12 h × (2 − 3/√7) ≈ 10.4 kWh a day, so a 30 kWh charge now passes.
        let context = historyContext(grid: { Self.isDaylight($0) ? 2 : 0 }, cautious: { Self.isDaylight($0) ? -1 : 0 })
        let result = evaluate(.history(context: context), profile: load(30, hours: 3), now: start,
                              tariffs: dailyTariffs(days: 22), balances: ["ON_PEAK": 0, "OFF_PEAK": -10],
                              cycleEnd: start.addingTimeInterval(20 * 86_400))

        let comparison = try #require(result.comparison)
        #expect(comparison.safety == .nowSafe)
        #expect(comparison.recommendedStart == start)
        #expect(comparison.ruledOut == nil)
    }
}

// MARK: - Codex review, 2026-10-18

extension LoadTimingForecastEstimatorTests {
    @Test("A run straddling the safety cutoff counts the draw before it")
    func drawIsProratedAtTheSafetyCutoff() throws {
        // 08:10, so the seven-day cutoff falls inside the 08:00–08:30 history step.
        // History adds 1 kW in both runs; the 2 kW run outlasts the cutoff by 10 minutes,
        // so 336 kWh is drawn before it and the bank ends 164.9 + 168 − 336 = −3.1 there.
        // Dropping the straddling step would count only 335.67 kWh and pass at −2.77.
        let now = start.addingTimeInterval(600)
        let hours = 7 * 24 + 1.0 / 6
        let run = LoadProfile(id: "run", name: "Run", kind: .appliance, energyKwh: 2 * hours, durationHours: hours, carSettings: nil)
        let result = evaluate(.history(context: historyContext(grid: { _ in 1 })), profile: run, now: now,
                              tariffs: [tariff(0, 20 * 86_400, key: "P", buy: 0.31, sell: 0.04)],
                              balances: ["P": 164.9], cycleEnd: start.addingTimeInterval(20 * 86_400))

        let comparison = try #require(result.comparison)
        #expect(comparison.safety != .nowSafe)
    }
}

// MARK: - Cautious forecast is a 1-in-4 week, not seven 1-in-10 days

extension LoadTimingForecastEstimatorTests {
    @Test("The cautious forecast moves each interval about 20% toward pv_estimate10")
    func cautiousForecastIsAOneInFourWeek() throws {
        // Typical solar banks 20 kWh a day for a week; pv_estimate10 says nothing at all.
        // Seven days of pv_estimate10 would leave a 60 kWh charge 60 short; a 1-in-4 week
        // banks 140 × (1 − 0.199) ≈ 112, so it passes. A 120 kWh charge still fails.
        let week = halfHourForecast(hours: 7 * 24 + 1, typical: { $0.truncatingRemainder(dividingBy: 24) < 10 ? 2 : 0 },
                                    cautious: { _ in 0 })
        func safety(_ kwh: Double) throws -> LoadTimingForecastEstimator.Safety {
            let result = safetyEvaluate(forecast: week, tariffs: [tariff(0, 20 * 86_400, key: "P", buy: 0.31, sell: 0.04)],
                                        balances: ["P": 0], profile: load(kwh, hours: 6))
            return try #require(result.comparison).safety
        }
        #expect(abs(LoadTimingForecastEstimator.forecastCautiousWeight - 0.199) < 0.001)
        #expect(try safety(60) == .nowSafe)
        #expect(try safety(120) == .noSafeStart(periodKey: "P"))
    }

    @Test("A sunny week with a gloomy pv_estimate10 tail still suggests Monday's On-Peak")
    func sunnyWeekWithAGloomyTailSuggestsMondayOnPeak() throws {
        // Shaped on the owner's Monday 2026-10-19 (06:04): Off-Peak owed, On-Peak +4.6,
        // a 52.7 kWh charge, 4 kW of median solar 09–17 each day, home 1.2 kW, and
        // pv_estimate10 falling from 80% of the median on Monday to 12% by Sunday.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let dayZero = start.addingTimeInterval(-8 * 3600)
        let monday = try #require((0..<7).first { calendar.component(.weekday, from: dayZero.addingTimeInterval(Double($0) * 86_400)) == 2 })
        let mondayStart = dayZero.addingTimeInterval(Double(monday) * 86_400)
        let now = mondayStart.addingTimeInterval(6 * 3600 + 4 * 60)
        let tail = [0.8, 0.7, 0.8, 0.4, 0.35, 0.25, 0.12, 0.8]
        let intervals = (0..<(8 * 48)).map { index -> SolarForecastInterval in
            let periodStart = mondayStart.addingTimeInterval(Double(index) * 1800)
            let hour = Double(index % 48) / 2
            let sun = (9..<17).contains(hour) ? 4.0 : 0
            return SolarForecastInterval(periodStart: periodStart, periodEnd: periodStart.addingTimeInterval(1800),
                                         powerKw: sun, cautiousPowerKw: sun * tail[index / 48])
        }
        let context = historyContext(home: 1.2, grid: { Self.isDaylight($0) ? 1 : -0.8 }, cautious: { _ in -0.8 })
        let weekday = { (day: Int) in !calendar.isDateInWeekend(dayZero.addingTimeInterval(Double(day) * 86_400)) }
        let car = LoadProfile(id: "car", name: "Charge the car", kind: .appliance, energyKwh: 52.7, durationHours: 52.7 / 9, carSettings: nil)
        let result = Estimator.evaluate(profile: car, now: now,
                                        timing: timing(dailyTariffs(days: monday + 25, onPeakDay: weekday),
                                                       balances: ["ON_PEAK": 4.615, "OFF_PEAK": -66]),
                                        projection: .forecast(intervals: intervals, context: context),
                                        balanceSourceTime: now, billingCycleEnd: now.addingTimeInterval(23 * 86_400),
                                        currencyCode: "USD")

        let comparison = try #require(result.comparison)
        #expect(comparison.recommendedStart == mondayStart.addingTimeInterval(8 * 3600))
        #expect(abs(comparison.recommendedCost - 52.7 * 0.04) < 1e-6)
    }
}

// MARK: - Device report, 2026-10-19 06:37 (a fresh forecast starting after the energy data)

extension LoadTimingForecastEstimatorTests {
    @Test("A forecast that starts after the energy data still prices the card, with history filling the gap")
    func historyFillsTheGapBeforeTheForecastStarts() throws {
        // Energy data through 08:20, so the projection starts at 08:25; a forecast fetched
        // at 08:36 starts at 08:30. History's 6 kW fills the 5 minutes between, then the
        // forecast's 3 kW of solar against a 1 kW home runs to the end of the tariff.
        let source = start.addingTimeInterval(20 * 60), now = start.addingTimeInterval(40 * 60)
        let intervals = (1..<4).map { forecast(3, from: TimeInterval($0) * 1800, to: TimeInterval($0 + 1) * 1800) }
        let result = Estimator.evaluate(profile: profile(0.5, hours: 0.5), now: now,
                                        timing: timing([tariff(0, 7200)], balances: ["p": 2]),
                                        projection: .forecast(intervals: intervals, context: historyContext(home: 1, grid: { _ in 6 })),
                                        balanceSourceTime: source, billingCycleEnd: start.addingTimeInterval(86_400),
                                        currencyCode: "USD")

        let comparison = try #require(result.comparison, "\(String(describing: result.unavailableReason))")
        #expect(comparison.assumptions.contains { $0.hasPrefix("Solar follows your Solcast forecast") })
        let lane = try #require(comparison.lanes.first { $0.periodKey == "p" })
        #expect(abs(lane.projectedKwh - (2 + 6 * 5.0 / 60 + 2 * 1.5)) < 1e-9)
    }
}

// MARK: - Device report, 2026-10-19 06:53 (energy data 33 minutes old)

extension LoadTimingForecastEstimatorTests {
    @Test("With grid history filling the gap, the forecast card takes energy data up to an hour old")
    func forecastWithGridHistoryAllowsHourOldEnergyData() throws {
        // Energy data through 00:00, read at 00:33: the server's data lagged, and a
        // 30-minute limit swapped the forecast card for history. History's 6 kW
        // fills 00:05–00:30, then the forecast's 3 kW of solar against a 1 kW home.
        let intervals = (1..<4).map { forecast(3, from: TimeInterval($0) * 1800, to: TimeInterval($0 + 1) * 1800) }
        func run(ageMinutes: Double) -> Estimator.Result {
            Estimator.evaluate(profile: profile(0.5, hours: 0.5), now: start.addingTimeInterval(ageMinutes * 60),
                               timing: timing([tariff(0, 7200)], balances: ["p": 2]),
                               projection: .forecast(intervals: intervals, context: historyContext(home: 1, grid: { _ in 6 })),
                               balanceSourceTime: start, billingCycleEnd: start.addingTimeInterval(86_400),
                               currencyCode: "USD")
        }

        let comparison = try #require(run(ageMinutes: 33).comparison, "\(String(describing: run(ageMinutes: 33).unavailableReason))")
        #expect(comparison.assumptions.contains { $0.hasPrefix("Solar follows your Solcast forecast") })
        let lane = try #require(comparison.lanes.first { $0.periodKey == "p" })
        #expect(abs(lane.projectedKwh - (2 + 6 * 25.0 / 60 + 2 * 1.5)) < 1e-9)

        #expect(run(ageMinutes: 61).unavailableReason == .staleBalance)
    }
}
