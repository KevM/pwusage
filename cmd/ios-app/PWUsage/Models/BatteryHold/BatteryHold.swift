import Foundation

struct BatteryHold: Decodable, Equatable {
    enum Status: String, Decodable { case active, restored, cancelled }
    let id: Int
    let siteID: String
    let status: Status
    let mode: BatteryHoldMode
    let originalReserve: Int
    let targetReserve: Int
    let createdAt: Date
    let safetyExpiresAt: Date
    let cancelledObservedReserve: Int?

    var monitoring: BatteryHoldMonitoring?

    private enum CodingKeys: String, CodingKey {
        case id, status, mode, monitoring
        case siteID = "site_id"
        case originalReserve = "original_reserve"
        case targetReserve = "target_reserve"
        case createdAt = "created_at"
        case safetyExpiresAt = "safety_expires_at"
        case cancelledObservedReserve = "cancelled_observed_reserve"
    }

    func validating(siteID: String, status: Status) throws -> Self {
        guard self.siteID == siteID, self.status == status, id > 0,
              (0 ... 100).contains(originalReserve), (0 ... 100).contains(targetReserve),
              targetReserve <= 80 || targetReserve == 100,
              safetyExpiresAt > createdAt,
              cancelledObservedReserve.map({ (0 ... 100).contains($0) }) ?? true else {
            throw PWUsageAPIError.invalidResponse
        }
        return self
    }
}
