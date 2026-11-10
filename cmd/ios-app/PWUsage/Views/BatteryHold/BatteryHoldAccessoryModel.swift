import Foundation

/// What the Smart Shift tab's bottom accessory says while Battery Saver is on: that it is on, the level
/// it holds the battery at, and how close home use is to the level that counts as a job.
struct BatteryHoldAccessoryModel: Equatable {
    /// A job counts as running once home use is this far above the starting level. Mirrors
    /// `RISE_THRESHOLD_W` in `cmd/next-app/src/lib/battery-hold-detection.ts`.
    static let detectionRiseW = 1000.0
    /// Matches `BatteryHoldPresentation.loadSummary`: an older reading is not "now".
    private static let readingLifetime: TimeInterval = 20 * 60

    let title: String
    let detail: String?
    let accessibilityLabel: String

    init?(state: BatteryHoldState, now: Date) {
        guard state.statusIsCurrent(at: now), let hold = state.response?.hold else { return nil }
        title = "Battery Saver · \(hold.targetReserve)%"
        var spoken = ["Battery Saver on, held at \(hold.targetReserve)%."]
        var parts: [String] = []
        if let monitoring = hold.monitoring,
           let sampledAt = monitoring.sampledAt, now.timeIntervalSince(sampledAt) <= Self.readingLifetime,
           let home = monitoring.homeLoadW, home.isFinite, home >= 0 {
            parts.append("Home \(Self.kilowatts(home))")
            spoken.append("Home \(Self.kilowatts(home)).")
            if hold.mode == .auto, let baseline = monitoring.baselineLoadW, baseline.isFinite, baseline >= 0 {
                let level = Self.kilowatts(baseline + Self.detectionRiseW)
                parts.append("job at \(level)")
                spoken.append("A job is detected at \(level).")
            }
        }
        detail = parts.isEmpty ? nil : parts.joined(separator: " · ")
        accessibilityLabel = (spoken + ["Open Battery Saver."]).joined(separator: " ")
    }

    private static func kilowatts(_ watts: Double) -> String {
        let value = (watts / 1000).formatted(.number.precision(.fractionLength(0 ... 1)))
        return "\(value) kW"
    }
}
