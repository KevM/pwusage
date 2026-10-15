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

    /// Content-state schema 1, as documented in docs/battery-hold-live-activity-delivery.md.
    /// Keys match the server's camelCase; dates are Swift's default Codable
    /// representation (seconds since 2001-01-01T00:00:00Z), because ActivityKit
    /// decodes pushes with a default `JSONDecoder`. Values a newer server adds
    /// decode to `.unknown` so an update degrades instead of being dropped.
    struct ContentState: Codable, Hashable {
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

        /// The data time of this state, matching the server's APNs `timestamp`.
        /// A state with an older data time never replaces a newer one.
        var dataTime: Date { max(startedAt, checkedAt ?? .distantPast, endedAt ?? .distantPast) }

        /// When a non-final state should be treated as out of date: ten minutes
        /// past the next scheduled check, as the server's `stale-date` does.
        var staleDate: Date? {
            guard status == .active, let nextCheckAt else { return nil }
            return nextCheckAt.addingTimeInterval(10 * 60)
        }

        var isFinal: Bool { status != .active }
    }
}

extension BatteryHoldActivityAttributes.ContentState {
    private enum CodingKeys: String, CodingKey {
        case schema, holdId, status, mode, phase, originalReserve, targetReserve, estimatedLoadW
        case startedAt, safetyExpiresAt, checkedAt, nextCheckAt, endedAt, restoreReason, cancelledObservedReserve
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schema = try c.decode(Int.self, forKey: .schema)
        holdId = try c.decode(Int.self, forKey: .holdId)
        status = try c.decode(Status.self, forKey: .status)
        // An unrecognized mode is shown as Auto: its eight-hour safety deadline is the conservative reading.
        mode = (try? c.decodeIfPresent(String.self, forKey: .mode)).flatMap { $0.flatMap(BatteryHoldMode.init(rawValue:)) } ?? .auto
        phase = try c.decodeIfPresent(Phase.self, forKey: .phase)
        originalReserve = try c.decode(Int.self, forKey: .originalReserve)
        targetReserve = try c.decode(Int.self, forKey: .targetReserve)
        estimatedLoadW = try c.decodeIfPresent(Double.self, forKey: .estimatedLoadW)
        startedAt = try c.decode(Date.self, forKey: .startedAt)
        safetyExpiresAt = try c.decode(Date.self, forKey: .safetyExpiresAt)
        checkedAt = try c.decodeIfPresent(Date.self, forKey: .checkedAt)
        nextCheckAt = try c.decodeIfPresent(Date.self, forKey: .nextCheckAt)
        endedAt = try c.decodeIfPresent(Date.self, forKey: .endedAt)
        restoreReason = try c.decodeIfPresent(RestoreReason.self, forKey: .restoreReason)
        cancelledObservedReserve = try c.decodeIfPresent(Int.self, forKey: .cancelledObservedReserve)
    }
}
