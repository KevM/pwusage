import Foundation

struct BatteryHoldMonitoring: Decodable, Equatable {
    enum Phase: String, Decodable {
        case watching, restoring, timer
        case loadRunning = "load_running"
        case confirmingEnd = "confirming_end"
        case waitingForData = "waiting_for_data"
        case checkFailed = "check_failed"
    }
    let phase: Phase
    let checkedAt: Date
    let nextCheckAt: Date
    let sampledAt: Date?
    let estimatedLoadW: Double?
    var baselineLoadW: Double? = nil
    var homeLoadW: Double? = nil
    var peakLoadW: Double? = nil

    private enum CodingKeys: String, CodingKey {
        case phase
        case checkedAt = "checked_at"
        case nextCheckAt = "next_check_at"
        case sampledAt = "sampled_at"
        case estimatedLoadW = "estimated_load_w"
        case baselineLoadW = "baseline_load_w"
        case homeLoadW = "home_load_w"
        case peakLoadW = "peak_load_w"
    }
}
