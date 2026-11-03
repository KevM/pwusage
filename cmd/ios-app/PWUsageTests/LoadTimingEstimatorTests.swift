import Foundation
@testable import PWUsage
import Testing

@Suite("Load Timing Estimator Tests")
struct LoadTimingEstimatorTests {
    @Test("Car charging level changes wall energy and duration while preserving battery energy")
    func carLevelAssumptionsApply() throws {
        let settings = CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20, targetStateOfCharge: 30, chargingLevel: .level1)
        let level1Estimate = try #require(LoadTimingEstimator.carChargeEstimate(settings: settings))
        let level2Estimate = try #require(LoadTimingEstimator.carChargeEstimate(
            settings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20, targetStateOfCharge: 30, chargingLevel: .level2)
        ))

        #expect(level1Estimate.batteryKwh == 6)
        #expect(abs(level1Estimate.wallKwh - 7.058_823_529) < 0.000_001)
        #expect(abs(level1Estimate.durationHours - 4.705_882_352) < 0.000_001)
        #expect(abs(level2Estimate.wallKwh - 6.666_666_667) < 0.000_001)
        #expect(abs(level2Estimate.durationHours - 0.740_740_741) < 0.000_001)
        #expect(level1Estimate.wallKwh > level2Estimate.wallKwh)
        #expect(level1Estimate.durationHours > level2Estimate.durationHours)
    }

    @Test("Zero car charge is distinct from invalid input")
    func zeroCarChargeIsValid() throws {
        let estimate = try #require(LoadTimingEstimator.carChargeEstimate(
            settings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 80, targetStateOfCharge: 80, chargingLevel: .level1)
        ))
        #expect(estimate.batteryKwh == 0)
        #expect(estimate.wallKwh == 0)
        #expect(estimate.durationHours == 0)
    }

    @Test("Invalid car settings never produce an estimate")
    func invalidCarSettingsAreRejected() {
        #expect(LoadTimingEstimator.carChargeEstimate(
            settings: CarLoadSettings(capacityKwh: .nan, initialStateOfCharge: 20, targetStateOfCharge: 80, chargingLevel: .level1)
        ) == nil)
        #expect(LoadTimingEstimator.carChargeEstimate(
            settings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: .infinity, targetStateOfCharge: 80, chargingLevel: .level1)
        ) == nil)
        #expect(LoadTimingEstimator.carChargeEstimate(
            settings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 80, targetStateOfCharge: 20, chargingLevel: .level1)
        ) == nil)
        #expect(LoadTimingEstimator.carChargeEstimate(
            settings: CarLoadSettings(capacityKwh: 0, initialStateOfCharge: 20, targetStateOfCharge: 80, chargingLevel: .level1)
        ) == nil)
        #expect(LoadTimingEstimator.carChargeEstimate(
            settings: CarLoadSettings(capacityKwh: LoadProfile.maximumCarCapacityKwh + 1, initialStateOfCharge: 20, targetStateOfCharge: 80, chargingLevel: .level1)
        ) == nil)
    }
}
