import Foundation

@MainActor
final class SolarLayoutRevalidationHandle {
    private(set) var isCancelled = false
    var task: Task<Void, Never>?

    func cancel() {
        isCancelled = true
        task?.cancel()
    }
}

/// Runs one layout revalidation later. Injected so tests advance it deterministically.
@MainActor
protocol SolarLayoutRevalidationScheduling: AnyObject {
    func schedule(after delay: TimeInterval, _ work: @escaping @MainActor () async -> Void)
        -> SolarLayoutRevalidationHandle
}

@MainActor
final class TaskSolarLayoutRevalidationScheduler: SolarLayoutRevalidationScheduling {
    func schedule(
        after delay: TimeInterval,
        _ work: @escaping @MainActor () async -> Void
    ) -> SolarLayoutRevalidationHandle {
        let handle = SolarLayoutRevalidationHandle()
        handle.task = Task { @MainActor in
            try? await Task.sleep(for: .seconds(max(delay, 1)))
            guard !Task.isCancelled, !handle.isCancelled else { return }
            await work()
        }
        return handle
    }
}

/// A layout status and when the server last confirmed it.
struct SolarLayoutCacheEntry {
    static let finalLifetime: TimeInterval = 6 * 60 * 60
    static let transitionalLifetime: TimeInterval = 15 * 60
    /// How long a confirmed status may stand in for one a transient failure prevented.
    static let validationLifetime: TimeInterval = 6 * 60 * 60
    /// After a transient failure, a pending status is rechecked this soon. Bounded by
    /// `validationLifetime`, since the status is dropped once that passes.
    static let retryDelay: TimeInterval = 5 * 60

    let response: MobileSolarLayoutResponse
    let validatedAt: Date

    /// Final statuses change only when detection reruns; transitional ones are rechecked
    /// soon so a newly detected layout is picked up promptly.
    var lifetime: TimeInterval { isTransitional ? Self.transitionalLifetime : Self.finalLifetime }

    var isTransitional: Bool {
        guard case .enabled(_, let layout, let reason) = response, layout == nil else { return false }
        return reason == .needsLocation || reason == .pending || reason == nil
    }
}

struct SolarActualsCacheEntry {
    static let lifetime: TimeInterval = 60 * 60
    let hours: [MobileSolarActualsHour]?
    let fetchedAt: Date
}
