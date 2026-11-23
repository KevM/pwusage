import Foundation

public struct BatteryHoldMonitoring: Decodable, Equatable, Sendable {
    public enum Phase: String, Decodable, Sendable {
        case watching, restoring, timer
        case loadRunning = "load_running"
        case confirmingEnd = "confirming_end"
        case waitingForData = "waiting_for_data"
        case checkFailed = "check_failed"
    }
    public let phase: Phase
    public let checkedAt: Date
    public let nextCheckAt: Date
    public let sampledAt: Date?
    public let estimatedLoadW: Double?
    public var baselineLoadW: Double?
    public var homeLoadW: Double?
    public var peakLoadW: Double?
    public var batteryPercent: Double?

    public init(
        phase: Phase, checkedAt: Date, nextCheckAt: Date, sampledAt: Date?, estimatedLoadW: Double?,
        baselineLoadW: Double? = nil, homeLoadW: Double? = nil, peakLoadW: Double? = nil,
        batteryPercent: Double? = nil
    ) {
        self.phase = phase
        self.checkedAt = checkedAt
        self.nextCheckAt = nextCheckAt
        self.sampledAt = sampledAt
        self.estimatedLoadW = estimatedLoadW
        self.baselineLoadW = baselineLoadW
        self.homeLoadW = homeLoadW
        self.peakLoadW = peakLoadW
        self.batteryPercent = batteryPercent
    }

    private enum CodingKeys: String, CodingKey {
        case phase
        case checkedAt = "checked_at"
        case nextCheckAt = "next_check_at"
        case sampledAt = "sampled_at"
        case estimatedLoadW = "estimated_load_w"
        case baselineLoadW = "baseline_load_w"
        case homeLoadW = "home_load_w"
        case peakLoadW = "peak_load_w"
        case batteryPercent = "battery_percent"
    }
}
