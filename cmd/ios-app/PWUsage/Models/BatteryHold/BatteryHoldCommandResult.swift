import Foundation

struct BatteryHoldCommandResult: Decodable, Equatable {
    enum Status: String, Decodable {
        case succeeded = "ok"
        case alreadyActive = "already_active"
        case reserveChanged = "reserve_changed"
    }
    let status: Status
    let hold: BatteryHold?
    let current: Int?

    func validating(siteID: String, command: BatteryHoldCommand) throws -> Self {
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
