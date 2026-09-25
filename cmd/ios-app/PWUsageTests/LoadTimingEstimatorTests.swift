import Testing
@testable import PWUsage

@Suite("Load Timing Estimator Tests")
struct LoadTimingEstimatorTests {
    @Test("Matches web covered, tight, partial, bought, and unknown verdicts")
    func verdictsMatchWeb() {
        #expect(LoadTimingEstimator.costToRun(60, pricing: .init(surplusKwh: 120, buyRate: 0.15, sellRate: 0.03), headroomKwh: 100).verdict == .covered)
        let tight = LoadTimingEstimator.costToRun(60, pricing: .init(surplusKwh: 70, buyRate: 0.48, sellRate: 0.12), headroomKwh: 100)
        #expect(tight.verdict == .tight)
        #expect(abs((tight.total ?? .nan) - 7.2) < 0.000_001)
        #expect(LoadTimingEstimator.costToRun(60, pricing: .init(surplusKwh: 10, buyRate: 0.48, sellRate: 0.12)).verdict == .partial)
        #expect(LoadTimingEstimator.costToRun(5, pricing: .init(surplusKwh: -20, buyRate: 0.48, sellRate: 0.12)).verdict == .bought)
        #expect(LoadTimingEstimator.costToRun(8, pricing: nil).verdict == .unknown)
        let unresolvedRates = LoadTimingEstimator.costToRun(8, pricing: .init(surplusKwh: 0, buyRate: 0, sellRate: 0))
        #expect(unresolvedRates.total == nil)
        #expect(unresolvedRates.verdict == .unknown)
    }

    @Test("Prices covered and bought energy at sell and buy rates")
    func pricesEnergyAtItsMarginalRate() {
        let result = LoadTimingEstimator.costToRun(60, pricing: .init(surplusKwh: 10, buyRate: 0.48, sellRate: 0.12))
        #expect(result.coveredKwh == 10)
        #expect(result.boughtKwh == 50)
        #expect(abs((result.total ?? .nan) - 25.2) < 0.000_001)
        let freeExport = LoadTimingEstimator.costToRun(5, pricing: .init(surplusKwh: 50, buyRate: 0.48, sellRate: 0))
        #expect(freeExport.total == 0)
        #expect(freeExport.verdict == .covered)
    }

    @Test("Provides web preset sizes and headroom thresholds")
    func profilesMatchWeb() {
        #expect(LoadTimingEstimator.profiles == [
            .init(id: "laundry", label: "Laundry", kwh: 8, headroomKwh: 20),
            .init(id: "dishwasher", label: "Dishwasher", kwh: 5, headroomKwh: 5),
        ])
        #expect(LoadTimingEstimator.customAmount(1) == 1)
        #expect(LoadTimingEstimator.customAmount(60) == 60)
        #expect(LoadTimingEstimator.customAmount(100) == 100)
        #expect(LoadTimingEstimator.customAmount(0) == 1)
        #expect(LoadTimingEstimator.customAmount(120) == 100)
    }

    @Test("Calculates energy needed to charge a car to its target")
    func carChargeEnergyUsesCapacityAndChargeDifference() {
        #expect(LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: 20, targetPercent: 80) == 36)
        #expect(LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: 80, targetPercent: 20) == 0)
        #expect(LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: 80, targetPercent: 80) == 0)
    }

    @Test("Invalid car charge inputs never return negative or non-finite energy")
    func carChargeEnergyRejectsInvalidInputs() {
        for result in [
            LoadTimingEstimator.carChargeKwh(capacityKwh: .nan, currentPercent: 20, targetPercent: 80),
            LoadTimingEstimator.carChargeKwh(capacityKwh: .infinity, currentPercent: 20, targetPercent: 80),
            LoadTimingEstimator.carChargeKwh(capacityKwh: -60, currentPercent: 20, targetPercent: 80),
            LoadTimingEstimator.carChargeKwh(capacityKwh: .greatestFiniteMagnitude, currentPercent: 0, targetPercent: 100),
            LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: .infinity, targetPercent: 80),
            LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: 20, targetPercent: .nan),
        ] {
            #expect(result.isFinite)
            #expect(result >= 0)
        }
        #expect(LoadTimingEstimator.carChargeKwh(capacityKwh: 60, currentPercent: -10, targetPercent: 110) == 60)
    }
}
