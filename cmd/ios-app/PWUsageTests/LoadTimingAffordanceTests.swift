import Testing
@testable import PWUsage

@Suite
struct LoadTimingAffordanceTests {
    @Test
    func selectsLargestCoveredLoadAndNextShortfall() throws {
        let result = LoadTimingAffordance.evaluate(timing: timing(activeBalance: 17), plannedCarKwh: 30)

        #expect(result.state == .allowed(.dishwasher))
        #expect(result.periodName == "Peak")
        #expect(result.balanceKwh == 17)
        #expect(result.nextUnmet?.choice == .laundry)
        #expect(result.nextUnmet?.shortfallKwh == 3)
    }

    @Test
    func laundryIsCoveredAtItsHeadroomBoundary() {
        let result = LoadTimingAffordance.evaluate(timing: timing(activeBalance: 20), plannedCarKwh: 30)
        #expect(result.state == .allowed(.laundry))
        #expect(result.nextUnmet?.choice == .car)
        #expect(result.nextUnmet?.shortfallKwh == 28)
    }

    @Test
    func carUsesDynamicHeadroomForPositivePlannedCharge() {
        let result = LoadTimingAffordance.evaluate(timing: timing(activeBalance: 48), plannedCarKwh: 30)
        #expect(result.state == .allowed(.car))
        #expect(result.nextUnmet == nil)
    }

    @Test
    func deficitReturnsCautionForNextSmallestLoadAndShortfall() {
        let result = LoadTimingAffordance.evaluate(timing: timing(activeBalance: -4), plannedCarKwh: 30)
        #expect(result.state == .caution)
        #expect(result.nextUnmet?.choice == .dishwasher)
        #expect(result.nextUnmet?.shortfallKwh == 9)
    }

    @Test
    func syntheticActivePricingPeriodDoesNotReplaceMissingObservation() {
        let result = LoadTimingAffordance.evaluate(timing: timing(activeBalance: nil, syntheticActiveBalance: 100), plannedCarKwh: 30)
        #expect(result.state == .awaitingActiveBalance)
        #expect(result.periodName == nil)
        #expect(result.balanceKwh == nil)
    }

    @Test
    func zeroPlannedCarChargeDoesNotOfferCar() {
        let result = LoadTimingAffordance.evaluate(timing: timing(activeBalance: 50), plannedCarKwh: 0)
        #expect(result.state == .allowed(.laundry))
        #expect(result.choices.map(\.choice) == [.dishwasher, .laundry])
    }

    @Test
    func preservesNextCheaperPeriod() {
        let result = LoadTimingAffordance.evaluate(timing: timing(activeBalance: 17, nextCheaper: .init(name: "Off peak", marginalCost: 0.12, phrase: "in 2 hours")), plannedCarKwh: 30)
        #expect(result.nextCheaper == .init(name: "Off peak", marginalCost: 0.12, phrase: "in 2 hours"))
    }

    private func timing(activeBalance: Double?, syntheticActiveBalance: Double? = nil, nextCheaper: NextCheaperPeriod? = nil) -> LoadTiming {
        let active = LoadTimingPeriod(name: "Peak", marginalCost: 0.48, basis: activeBalance == nil ? "unobserved" : "buy", cycleNetExportKwh: activeBalance ?? 0, isActive: true, nextStartPhrase: nil, buyRate: 0.48, sellRate: 0.12)
        let periods = activeBalance == nil ? [] : [active]
        let pricingActive = LoadTimingPeriod(name: "Peak", marginalCost: 0.48, basis: "buy", cycleNetExportKwh: syntheticActiveBalance ?? activeBalance ?? 0, isActive: true, nextStartPhrase: nil, buyRate: 0.48, sellRate: 0.12)
        return LoadTiming(hasTariff: true, hasCycleData: true, activeIsCheapest: false, periods: periods, pricingPeriods: [pricingActive], nextCheaper: nextCheaper, nextCheaperPhrase: nextCheaper?.phrase, nextStartPhraseByKey: [:])
    }
}
