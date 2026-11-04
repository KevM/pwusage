import ActivityKit
import Foundation

/// The Live Activity for one battery hold. Shared by the app, which starts it,
/// and the widget extension, which draws it.
///
/// Attributes are fixed for the activity's lifetime; only `ContentState` changes.
/// The server never sends attributes (there is no push-to-start), so they can
/// carry what only the app knows: the site's name and time zone, and the
/// registration identifier the server keys this activity's push token by.
struct BatteryHoldActivityAttributes: ActivityAttributes {
    /// Apple ends a standard Live Activity eight hours after it starts. A fixed
    /// hold can run 24 hours; the activity says so instead of restarting itself.
    static let displayLimit: TimeInterval = 8 * 60 * 60

    let siteID: String
    let siteName: String
    let holdID: Int
    let registrationID: UUID
    let timeZoneIdentifier: String
    let activityStartedAt: Date

    typealias ContentState = BatteryHoldActivityContentState
}

/// Content-state schema 1, as documented in docs/battery-hold-live-activity-delivery.md.
/// Keys match the server's camelCase; dates are Swift's default Codable
/// representation (seconds since 2001-01-01T00:00:00Z), because ActivityKit
/// decodes pushes with a default `JSONDecoder`. Values a newer server adds
/// decode to `.unknown` so an update degrades instead of being dropped.
struct BatteryHoldActivityContentState: Codable, Hashable {
    static let schema = 1

    enum Status: String, Codable, Hashable {
        case active, restored, cancelled
        /// Local only: the app saw the hold end without learning how.
        case ended
        case unknown
        init(from decoder: any Decoder) throws {
            self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    enum Phase: String, Codable, Hashable {
        case watching, timer, restoring
        case loadRunning = "load_running"
        case confirmingEnd = "confirming_end"
        case waitingForData = "waiting_for_data"
        case checkFailed = "check_failed"
        case unknown
        init(from decoder: any Decoder) throws {
            self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    enum RestoreReason: String, Codable, Hashable {
        case manual, cancelled
        case loadEnded = "load_ended"
        case noLoadDetected = "no_load_detected"
        case safetyTimeout = "safety_timeout"
        case timerElapsed = "timer_elapsed"
        case reserveChanged = "reserve_changed"
        case unknown
        init(from decoder: any Decoder) throws {
            self = Self(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    var schema: Int = Self.schema
    var holdId: Int
    var status: Status
    var mode: BatteryHoldMode
    var phase: Phase?
    var originalReserve: Int
    var targetReserve: Int
    var estimatedLoadW: Double?
    var startedAt: Date
    var safetyExpiresAt: Date
    var checkedAt: Date?
    var nextCheckAt: Date?
    var endedAt: Date?
    var restoreReason: RestoreReason?
    var cancelledObservedReserve: Int?
    /// Home load from the monitor's last check: the latest sample (taken at
    /// `sampledAt`), the load when the hold started, and the peak since. Added
    /// to schema 1 as optional keys; older payloads omit them.
    var sampledAt: Date?
    var baselineLoadW: Double?
    var homeLoadW: Double?
    var peakLoadW: Double?
    /// The battery's charge (0...100, unrounded) from the last check or hold
    /// start. Optional schema-1 key; older payloads omit it.
    var batteryPercent: Double?

    enum CodingKeys: String, CodingKey {
        case schema, holdId, status, mode, phase, originalReserve, targetReserve, estimatedLoadW
        case startedAt, safetyExpiresAt, checkedAt, nextCheckAt, endedAt, restoreReason, cancelledObservedReserve
        case sampledAt, baselineLoadW, homeLoadW, peakLoadW, batteryPercent
    }

    /// The data time of this state, matching the server's APNs `timestamp`.
    /// A state with an older data time never replaces a newer one.
    var dataTime: Date { max(startedAt, checkedAt ?? .distantPast, endedAt ?? .distantPast) }

    /// How long past a due check the server's `stale-date` waits before a state is out of date.
    static let staleGrace: TimeInterval = 10 * 60
    /// The server checks every hold on a 15-minute boundary, so a first check
    /// is due within this long of any activity starting.
    static let firstCheckInterval: TimeInterval = 15 * 60

    /// When a non-final state should be treated as out of date: ten minutes
    /// past the next scheduled check, as the server's `stale-date` does.
    /// Before the first check there is no `nextCheckAt`, so the activity's
    /// start stands in for the last check; without a date ActivityKit would
    /// never mark it stale and a frozen activity would never say so.
    func staleDate(activityStartedAt: Date) -> Date? {
        guard status == .active else { return nil }
        return (nextCheckAt ?? activityStartedAt.addingTimeInterval(Self.firstCheckInterval))
            .addingTimeInterval(Self.staleGrace)
    }

    var isFinal: Bool { status != .active }
}
