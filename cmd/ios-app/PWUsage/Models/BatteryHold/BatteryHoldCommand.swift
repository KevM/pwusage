import Foundation

enum BatteryHoldCommand: Encodable, Equatable {
    case park(BatteryHoldChoice)
    case restore
    case dismiss

    private enum CodingKeys: String, CodingKey { case action, mode, durationHours, reserveChoice }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .park(let choice):
            try container.encode("park", forKey: .action)
            try container.encode(choice.mode, forKey: .mode)
            if choice.mode == .timer { try container.encode(choice.durationHours, forKey: .durationHours) }
            try container.encodeIfPresent(choice.reserveChoice, forKey: .reserveChoice)
        case .restore: try container.encode("restore", forKey: .action)
        case .dismiss: try container.encode("dismiss", forKey: .action)
        }
    }
}
