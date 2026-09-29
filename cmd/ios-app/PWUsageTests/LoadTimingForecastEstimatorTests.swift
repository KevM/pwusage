import Foundation
import Testing
@testable import PWUsage

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
            tariff(64_800, 86_400, key: "winter_offpeak", buy: 0.20, sell: 0.07)
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
            tariff(21_600, 43_200, key: "p", buy: 0.30, sell: 0.05)
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
}
