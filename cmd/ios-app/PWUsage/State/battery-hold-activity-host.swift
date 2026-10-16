import ActivityKit
import Foundation

/// ActivityKit behind `BatteryHoldActivityHost`. Thin on purpose: lifecycle
/// rules live in `BatteryHoldActivityCoordinator`, where tests can reach them.
/// What only a device can show (APNs delivery, token rotation, dismissal while
/// the app is closed) is listed under "Battery Hold Live Activity" in the iOS README.
@MainActor
final class ActivityKitBatteryHoldHost: BatteryHoldActivityHost {
    var activitiesEnabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    func activities() -> [any BatteryHoldActivityHandle] {
        Activity<BatteryHoldActivityAttributes>.activities.map(ActivityKitBatteryHoldHandle.init)
    }

    func start(attributes: BatteryHoldActivityAttributes,
               state: BatteryHoldActivityAttributes.ContentState) throws -> any BatteryHoldActivityHandle {
        // Token pushes only: no push-to-start, so a hold started elsewhere is
        // offered in the app rather than appearing on its own.
        let activity = try Activity.request(
            attributes: attributes,
            content: ActivityContent(state: state, staleDate: state.staleDate),
            pushType: .token
        )
        return ActivityKitBatteryHoldHandle(activity)
    }
}

@MainActor
final class ActivityKitBatteryHoldHandle: BatteryHoldActivityHandle {
    private let activity: Activity<BatteryHoldActivityAttributes>

    init(_ activity: Activity<BatteryHoldActivityAttributes>) { self.activity = activity }

    var id: String { activity.id }
    var attributes: BatteryHoldActivityAttributes { activity.attributes }
    var state: BatteryHoldActivityAttributes.ContentState { activity.content.state }
    var pushToken: Data? { activity.pushToken }

    var lifecycle: BatteryHoldActivityLifecycle { Self.lifecycle(activity.activityState) }

    func pushTokenUpdates() -> AsyncStream<Data> {
        let updates = activity.pushTokenUpdates
        return AsyncStream { continuation in
            let task = Task {
                for await token in updates { continuation.yield(token) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func lifecycleUpdates() -> AsyncStream<BatteryHoldActivityLifecycle> {
        let updates = activity.activityStateUpdates
        return AsyncStream { continuation in
            let task = Task {
                for await state in updates { continuation.yield(Self.lifecycle(state)) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // `Activity` isn't declared Sendable, but ActivityKit expects these calls from
    // any context; the handle only ever passes it to them.
    func update(_ state: BatteryHoldActivityAttributes.ContentState) async {
        nonisolated(unsafe) let activity = activity
        await activity.update(ActivityContent(state: state, staleDate: state.staleDate))
    }

    func end(_ state: BatteryHoldActivityAttributes.ContentState?, immediately: Bool) async {
        nonisolated(unsafe) let activity = activity
        await activity.end(state.map { ActivityContent(state: $0, staleDate: nil) },
                           dismissalPolicy: immediately ? .immediate : .default)
    }

    nonisolated private static func lifecycle(_ state: ActivityState) -> BatteryHoldActivityLifecycle {
        switch state {
        case .stale: .stale
        case .ended: .ended
        case .dismissed: .dismissed
        default: .active
        }
    }
}
