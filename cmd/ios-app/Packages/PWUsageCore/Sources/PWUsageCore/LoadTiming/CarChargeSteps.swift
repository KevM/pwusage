#if canImport(FoundationEssentials)
    import FoundationEssentials
#else
    import Foundation
#endif

/// The 5% stepping rules for a car's current and target charge. An estimate doesn't need more
/// precision, so every edit snaps to a multiple of 5 and the target never drops below current.
public enum CarChargeSteps {
    public static let step = 5.0

    public static func snapped(_ value: Double) -> Double {
        guard value.isFinite else { return 0 }
        let nearest = (value / step + 0.5).rounded(.down) * step
        return min(100, max(0, nearest))
    }

    public static func steppedUp(_ value: Double) -> Double { min(100, snapped(value) + step) }

    public static func steppedDown(_ value: Double) -> Double { max(0, snapped(value) - step) }

    public static func settings(_ settings: CarLoadSettings, settingCurrent value: Double) -> CarLoadSettings {
        var updated = settings
        updated.initialStateOfCharge = snapped(value)
        updated.targetStateOfCharge = max(settings.targetStateOfCharge, updated.initialStateOfCharge)
        return updated
    }

    public static func settings(_ settings: CarLoadSettings, settingTarget value: Double) -> CarLoadSettings {
        var updated = settings
        updated.targetStateOfCharge = max(snapped(value), settings.initialStateOfCharge)
        return updated
    }
}
