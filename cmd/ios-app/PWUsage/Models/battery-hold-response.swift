import Foundation

struct BatteryHoldResponse: Decodable, Equatable {
    let hold: BatteryHold?
    let notice: BatteryHold?

    init(hold: BatteryHold?, notice: BatteryHold?) { self.hold = hold; self.notice = notice }

    private enum CodingKeys: String, CodingKey { case hold, notice }
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // An empty/error object must never be mistaken for a confirmed idle battery.
        hold = try container.decode(BatteryHold?.self, forKey: .hold)
        notice = try container.decode(BatteryHold?.self, forKey: .notice)
    }

    func validating(siteID: String) throws -> Self {
        _ = try hold?.validating(siteID: siteID, status: .active)
        _ = try notice?.validating(siteID: siteID, status: .cancelled)
        return self
    }
}
