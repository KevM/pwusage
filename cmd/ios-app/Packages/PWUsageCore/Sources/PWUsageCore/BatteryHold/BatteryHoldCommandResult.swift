import Foundation

public struct BatteryHoldCommandResult: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Sendable {
        case succeeded = "ok"
        case alreadyActive = "already_active"
        case reserveChanged = "reserve_changed"
    }
    public let status: Status
    public let hold: BatteryHold?
    public let current: Int?

    public init(status: Status, hold: BatteryHold?, current: Int?) {
        self.status = status
        self.hold = hold
        self.current = current
    }

    public func validating(siteID: String, command: BatteryHoldCommand) throws -> Self {
        _ = try hold?.validating(siteID: siteID, status: .active)
        switch (command, status) {
        case (.park, .succeeded), (.park, .alreadyActive):
            guard hold != nil else { throw PWUsageAPIError.invalidResponse }
        case (.restore, .reserveChanged):
            guard let current, (0 ... 100).contains(current) else { throw PWUsageAPIError.invalidResponse }
        case (.restore, .succeeded), (.dismiss, .succeeded): break
        default: throw PWUsageAPIError.invalidResponse
        }
        return self
    }
}
