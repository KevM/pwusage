import Foundation

extension BatteryHoldActivityContentState {
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schema = try container.decode(Int.self, forKey: .schema)
        holdId = try container.decode(Int.self, forKey: .holdId)
        status = try container.decode(Status.self, forKey: .status)
        // An unrecognized mode is shown as Auto: its eight-hour safety deadline is the conservative reading.
        mode = (try? container.decodeIfPresent(String.self, forKey: .mode))
            .flatMap { $0.flatMap(BatteryHoldMode.init(rawValue:)) } ?? .auto
        phase = try container.decodeIfPresent(Phase.self, forKey: .phase)
        originalReserve = try container.decode(Int.self, forKey: .originalReserve)
        targetReserve = try container.decode(Int.self, forKey: .targetReserve)
        estimatedLoadW = try container.decodeIfPresent(Double.self, forKey: .estimatedLoadW)
        startedAt = try container.decode(Date.self, forKey: .startedAt)
        safetyExpiresAt = try container.decode(Date.self, forKey: .safetyExpiresAt)
        checkedAt = try container.decodeIfPresent(Date.self, forKey: .checkedAt)
        nextCheckAt = try container.decodeIfPresent(Date.self, forKey: .nextCheckAt)
        endedAt = try container.decodeIfPresent(Date.self, forKey: .endedAt)
        restoreReason = try container.decodeIfPresent(RestoreReason.self, forKey: .restoreReason)
        cancelledObservedReserve = try container.decodeIfPresent(Int.self, forKey: .cancelledObservedReserve)
        sampledAt = try container.decodeIfPresent(Date.self, forKey: .sampledAt)
        baselineLoadW = try container.decodeIfPresent(Double.self, forKey: .baselineLoadW)
        homeLoadW = try container.decodeIfPresent(Double.self, forKey: .homeLoadW)
        peakLoadW = try container.decodeIfPresent(Double.self, forKey: .peakLoadW)
        batteryPercent = try container.decodeIfPresent(Double.self, forKey: .batteryPercent)
    }
}
