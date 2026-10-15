import Foundation

extension BatteryHoldActivityAttributes.ContentState {
    /// The state the server would push for this confirmed hold.
    init(hold: BatteryHold) {
        self.init(
            holdId: hold.id,
            status: Status(rawValue: hold.status.rawValue) ?? .unknown,
            mode: hold.mode,
            phase: hold.monitoring.map { Phase(rawValue: $0.phase.rawValue) ?? .unknown },
            originalReserve: hold.originalReserve,
            targetReserve: hold.targetReserve,
            estimatedLoadW: hold.monitoring?.estimatedLoadW,
            startedAt: hold.createdAt,
            safetyExpiresAt: hold.safetyExpiresAt,
            checkedAt: hold.monitoring?.checkedAt,
            nextCheckAt: hold.monitoring?.nextCheckAt,
            endedAt: nil,
            restoreReason: nil,
            cancelledObservedReserve: hold.cancelledObservedReserve
        )
    }

    /// This state, ended. `status` says how, when the app knows.
    func ended(as status: Status, reason: RestoreReason? = nil, at date: Date, observedReserve: Int? = nil) -> Self {
        var copy = self
        copy.status = status
        copy.restoreReason = reason
        copy.endedAt = date
        copy.cancelledObservedReserve = observedReserve ?? cancelledObservedReserve
        return copy
    }
}
