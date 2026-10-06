import Foundation

struct BatteryHoldChoice: Equatable {
    var mode: BatteryHoldMode = .auto
    var durationHours: Int = 4
    var reserveChoice: Int?

    var isValid: Bool {
        (mode == .auto || (1...24).contains(durationHours))
            && (reserveChoice == nil || reserveChoice == 80 || reserveChoice == 100)
    }
}
