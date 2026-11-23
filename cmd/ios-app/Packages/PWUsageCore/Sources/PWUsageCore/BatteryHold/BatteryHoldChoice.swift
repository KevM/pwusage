import Foundation

public struct BatteryHoldChoice: Equatable, Sendable {
    public var mode: BatteryHoldMode = .auto
    public var durationHours: Int = 4
    public var reserveChoice: Int?

    public init(mode: BatteryHoldMode = .auto, durationHours: Int = 4, reserveChoice: Int? = nil) {
        self.mode = mode
        self.durationHours = durationHours
        self.reserveChoice = reserveChoice
    }

    public var isValid: Bool {
        (mode == .auto || (1 ... 24).contains(durationHours))
            && (reserveChoice == nil || reserveChoice == 80 || reserveChoice == 100)
    }
}
