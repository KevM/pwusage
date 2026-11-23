import Foundation

public struct BatteryHoldReservePlan: Equatable, Sendable {
    public let target: Int
    public let requiresChoice: Bool

    public init(target: Int, requiresChoice: Bool) {
        self.target = target
        self.requiresChoice = requiresChoice
    }

    public static func make(stateOfCharge: Double) -> Self? {
        guard stateOfCharge.isFinite, (0 ... 100).contains(stateOfCharge) else { return nil }
        if stateOfCharge <= 80 { return .init(target: Int(stateOfCharge.rounded(.down)), requiresChoice: false) }
        if stateOfCharge <= 85 { return .init(target: 80, requiresChoice: false) }
        return .init(target: 100, requiresChoice: stateOfCharge < 95)
    }
}
