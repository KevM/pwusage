import Foundation

struct LoadTimingEstimator {
    struct CarChargeEstimate: Equatable {
        let batteryKwh: Double
        let wallKwh: Double
        let durationHours: Double
    }

    static func carChargeEstimate(settings: CarLoadSettings) -> CarChargeEstimate? {
        guard settings.capacityKwh.isFinite, settings.capacityKwh > 0,
              settings.capacityKwh <= LoadProfile.maximumCarCapacityKwh,
              settings.initialStateOfCharge.isFinite, (0...100).contains(settings.initialStateOfCharge),
              settings.targetStateOfCharge.isFinite, (settings.initialStateOfCharge...100).contains(settings.targetStateOfCharge) else {
            return nil
        }
        let batteryKwh = settings.capacityKwh * (settings.targetStateOfCharge - settings.initialStateOfCharge) / 100
        let power: Double
        let efficiency: Double
        switch settings.chargingLevel {
        case .level1: power = 1.5; efficiency = 0.85
        case .level2: power = 9; efficiency = 0.90
        }
        let wallKwh = batteryKwh / efficiency
        let durationHours = wallKwh / power
        guard batteryKwh.isFinite, wallKwh.isFinite, durationHours.isFinite else { return nil }
        return CarChargeEstimate(batteryKwh: batteryKwh, wallKwh: wallKwh, durationHours: durationHours)
    }
}
