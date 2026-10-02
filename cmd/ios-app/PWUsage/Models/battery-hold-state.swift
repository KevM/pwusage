import Foundation

struct BatteryHoldState: Equatable {
    var response: BatteryHoldResponse?
    var isRefreshing = false
    var isSubmitting = false
    var isCurrent = false
    var fetchedAt: Date?
    var failure: BatteryHoldFailure?
    var requiresReserveChoice = false

    var isBusy: Bool { isRefreshing || isSubmitting }
    func statusIsCurrent(at now: Date) -> Bool {
        guard isCurrent, let fetchedAt else { return false }
        return (0...120).contains(now.timeIntervalSince(fetchedAt))
    }
}
