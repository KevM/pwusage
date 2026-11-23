import Foundation

public struct BatteryHoldResponse: Decodable, Equatable, Sendable {
    public let hold: BatteryHold?
    public let notice: BatteryHold?

    public init(hold: BatteryHold?, notice: BatteryHold?) { self.hold = hold; self.notice = notice }

    private enum CodingKeys: String, CodingKey { case hold, notice }
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // An empty/error object must never be mistaken for a confirmed idle battery.
        hold = try container.decode(BatteryHold?.self, forKey: .hold)
        notice = try container.decode(BatteryHold?.self, forKey: .notice)
    }

    public func validating(siteID: String) throws -> Self {
        _ = try hold?.validating(siteID: siteID, status: .active)
        _ = try notice?.validating(siteID: siteID, status: .cancelled)
        return self
    }
}
