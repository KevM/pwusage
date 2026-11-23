import Foundation

public struct BatteryHold: Decodable, Equatable, Sendable {
    public enum Status: String, Decodable, Sendable { case active, restored, cancelled }
    public let id: Int
    public let siteID: String
    public let status: Status
    public let mode: BatteryHoldMode
    public let originalReserve: Int
    public let targetReserve: Int
    public let createdAt: Date
    public let safetyExpiresAt: Date
    public let cancelledObservedReserve: Int?

    public var monitoring: BatteryHoldMonitoring?

    public init(
        id: Int, siteID: String, status: Status, mode: BatteryHoldMode, originalReserve: Int, targetReserve: Int,
        createdAt: Date, safetyExpiresAt: Date, cancelledObservedReserve: Int?,
        monitoring: BatteryHoldMonitoring? = nil
    ) {
        self.id = id
        self.siteID = siteID
        self.status = status
        self.mode = mode
        self.originalReserve = originalReserve
        self.targetReserve = targetReserve
        self.createdAt = createdAt
        self.safetyExpiresAt = safetyExpiresAt
        self.cancelledObservedReserve = cancelledObservedReserve
        self.monitoring = monitoring
    }

    private enum CodingKeys: String, CodingKey {
        case id, status, mode, monitoring
        case siteID = "site_id"
        case originalReserve = "original_reserve"
        case targetReserve = "target_reserve"
        case createdAt = "created_at"
        case safetyExpiresAt = "safety_expires_at"
        case cancelledObservedReserve = "cancelled_observed_reserve"
    }

    public func validating(siteID: String, status: Status) throws -> Self {
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
