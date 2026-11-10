import Foundation

/// Home shows a reading only if it was fetched within `freshReadingLimit` when the
/// person arrives (launch, site switch, return from the background). Older ones stay
/// in memory for other screens, but Home waits for a fresh fetch instead.
extension DashboardCoordinator {
    static let freshReadingLimit: TimeInterval = 15 * 60

    func holdStaleReadings(at date: Date) {
        live.freshReadingWait = Self.wait(response: live.response, lastSuccess: live.lastSuccess, at: date)
        bill.freshReadingWait = Self.wait(response: bill.response, lastSuccess: bill.lastSuccess, at: date)
        power.freshReadingWait = Self.wait(response: power.response, lastSuccess: power.lastSuccess, at: date)
    }

    /// A pull to refresh sends every failed card back to waiting.
    func retryFailedWaits(at date: Date) {
        if live.freshReadingWait?.hasFailed == true { live.freshReadingWait = FreshReadingWait(since: date) }
        if bill.freshReadingWait?.hasFailed == true { bill.freshReadingWait = FreshReadingWait(since: date) }
        if power.freshReadingWait?.hasFailed == true { power.freshReadingWait = FreshReadingWait(since: date) }
    }

    func markWaitFailed(_ endpoint: Endpoint) {
        switch endpoint {
        case .live: live.freshReadingWait?.hasFailed = true
        case .bill: bill.freshReadingWait?.hasFailed = true
        case .power: power.freshReadingWait?.hasFailed = true
        }
    }

    /// Whether this endpoint must be fetched now, whatever its cadence: Home is
    /// waiting on it and the wait has not failed. A failed wait returns to the
    /// normal cadence, so a dead connection is not retried on every poll.
    private static func awaitsFetch(_ wait: FreshReadingWait?) -> Bool {
        wait.map { !$0.hasFailed } ?? false
    }

    var liveAwaitsFetch: Bool { Self.awaitsFetch(live.freshReadingWait) }
    var billAwaitsFetch: Bool { Self.awaitsFetch(bill.freshReadingWait) }
    var powerAwaitsFetch: Bool { Self.awaitsFetch(power.freshReadingWait) }

    private static func wait(response: (some Equatable)?, lastSuccess: Date?, at date: Date) -> FreshReadingWait? {
        guard response != nil, let lastSuccess,
              date.timeIntervalSince(lastSuccess) <= freshReadingLimit else {
            return FreshReadingWait(since: date)
        }
        return nil
    }
}
