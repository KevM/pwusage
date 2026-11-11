@testable import PWUsage
import Testing

@Suite("Car charge steps")
struct CarChargeStepsTests {
    private let settings = CarLoadSettings(
        capacityKwh: 60, initialStateOfCharge: 30, targetStateOfCharge: 80, chargingLevel: .level2)

    @Test("Snaps to the nearest 5%, ties up, within 0 to 100")
    func snapsToNearestFive() {
        #expect(CarChargeSteps.snapped(37) == 35)
        #expect(CarChargeSteps.snapped(38) == 40)
        #expect(CarChargeSteps.snapped(2.5) == 5)
        #expect(CarChargeSteps.snapped(100) == 100)
        #expect(CarChargeSteps.snapped(-3) == 0)
        #expect(CarChargeSteps.snapped(103) == 100)
    }

    @Test("Steps from off-grid values and stops at the ends")
    func stepsFromOffGridValues() {
        #expect(CarChargeSteps.steppedUp(37) == 40)
        #expect(CarChargeSteps.steppedDown(37) == 30)
        #expect(CarChargeSteps.steppedUp(100) == 100)
        #expect(CarChargeSteps.steppedDown(0) == 0)
    }

    @Test("Raising current above target raises target")
    func raisingCurrentAboveTargetRaisesTarget() {
        let result = CarChargeSteps.settings(settings, settingCurrent: 85)
        #expect(result.initialStateOfCharge == 85)
        #expect(result.targetStateOfCharge == 85)
    }

    @Test("Lowering current keeps target")
    func loweringCurrentKeepsTarget() {
        let result = CarChargeSteps.settings(settings, settingCurrent: 10)
        #expect(result.initialStateOfCharge == 10)
        #expect(result.targetStateOfCharge == 80)
    }

    @Test("Target never goes below current")
    func targetNeverBelowCurrent() {
        let result = CarChargeSteps.settings(settings, settingTarget: 10)
        #expect(result.initialStateOfCharge == 30)
        #expect(result.targetStateOfCharge == 30)
    }

    @Test("Current and target can both be 100")
    func currentAndTargetBothAtHundred() {
        let full = CarChargeSteps.settings(
            CarChargeSteps.settings(settings, settingCurrent: 100), settingTarget: 100)
        #expect(full.initialStateOfCharge == 100)
        #expect(full.targetStateOfCharge == 100)
    }

    @Test("Other settings are untouched")
    func otherSettingsAreUntouched() {
        let result = CarChargeSteps.settings(settings, settingCurrent: 45)
        #expect(result.capacityKwh == 60)
        #expect(result.chargingLevel == .level2)
    }
}
