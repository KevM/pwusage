import Foundation

/// Monotonic retry bookkeeping for one endpoint.
///
/// Cadence is deliberately not measured with `Date`. The wall clock can move in
/// either direction (a user change or an NTP correction), so a retry window
/// measured against it can shrink or stall. A `ContinuousClock.Instant` only
/// moves forward, and it is recorded when a request *finishes*: time spent on
/// the wire does not eat into the next interval, and a cancelled request records
/// nothing at all.
struct EndpointCadence: Equatable {
    private(set) var lastAttempt: ContinuousClock.Instant?

    /// Whether `interval` has elapsed since the last recorded attempt.
    func isDue(at instant: ContinuousClock.Instant, interval: Duration) -> Bool {
        guard let lastAttempt else { return true }
        return lastAttempt.duration(to: instant) >= interval
    }

    mutating func recordAttempt(at instant: ContinuousClock.Instant) {
        lastAttempt = instant
    }

    mutating func reset() {
        lastAttempt = nil
    }
}
