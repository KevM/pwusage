import Foundation
@testable import PWUsage
import Testing

@Suite("Load Timing Estimator Tests")
struct LoadTimingEstimatorTests {
    @Test("Car charging level changes wall energy and duration while preserving battery energy")
    func carLevelAssumptionsApply() throws {
        let settings = CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20, targetStateOfCharge: 30, chargingLevel: .level1)
        let l1 = try #require(LoadTimingEstimator.carChargeEstimate(settings: settings))
        let l2 = try #require(LoadTimingEstimator.carChargeEstimate(
            settings: CarLoadSettings(capacityKwh: 60, initialStateOfCharge: 20, targetStateOfCharge: 30, chargingLevel: .level2)
        ))

        #expect(l1.batteryKwh == 6)
        #expect(abs(l1.wallKwh - 7.058_823_529) < 0.000_001)
        #expect(abs(l1.durationHours - 4.705_882_352) < 0.000_001)
        #expect(abs(l2.wallKwh - 6.666_666_667) < 0.000_001)
        #expect(abs(l2.durationHours - 0.740_740_741) < 0.000_001)
        #expect(l1.wallKwh > l2.wallKwh)
        #expect(l1.durationHours > l2.durationHours)
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
