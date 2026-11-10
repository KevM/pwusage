import Foundation

/// What the Smart Shift tab's bottom accessory says while Battery Saver is on: the level it holds the battery at.
struct BatteryHoldAccessoryModel: Equatable {
    let title: String
    let accessibilityLabel: String

    init?(state: BatteryHoldState, now: Date) {
        guard state.statusIsCurrent(at: now), let hold = state.response?.hold else { return nil }
        title = "Battery holding at \(hold.targetReserve)%"
        accessibilityLabel = title + ". Open Battery Saver."
    }
}
