import Foundation
import os

/// Starts, registers, reconciles and ends battery hold Live Activities.
///
/// Nothing here can affect a hold: every failure is logged and absorbed, and
/// the only server writes are this device's own push-token registrations.
@MainActor
@Observable
final class BatteryHoldActivityCoordinator: BatteryHoldActivityObserving {
    /// Holds this device currently shows, for the sheet's offer.
    var shownHoldIDs: Set<Int> = []

    @ObservationIgnored let host: any BatteryHoldActivityHost
    @ObservationIgnored let api: any BatteryHoldActivityAPI
    @ObservationIgnored let apnsEnvironment: ApnsEnvironment?
    @ObservationIgnored let store: BatteryHoldActivityRegistrationStore
    @ObservationIgnored let now: () -> Date
    @ObservationIgnored let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored let signOutTimeout: Duration
    @ObservationIgnored let logger = Logger(subsystem: "fm.rodeo.pwusage", category: "battery-hold-activity")
    @ObservationIgnored var siteNames: [String: String] = [:]
    @ObservationIgnored var tracked: [String: Tracked] = [:]
    /// Bumped on sign-out and session loss, so late responses change nothing.
    @ObservationIgnored var generation = 0
    @ObservationIgnored var sessionActive = false
    @ObservationIgnored var isReconciling = false
    @ObservationIgnored var reconcileRequested = false

    static let retryDelays: [Duration] = [.seconds(2), .seconds(10), .seconds(30)]

    final class Tracked {
        let handle: any BatteryHoldActivityHandle
        var observers: [Task<Void, Never>] = []
        var latestToken: Data?
        /// The last registration queued; each waits for the one before it.
        var registration: Task<Void, Never>?
        init(handle: any BatteryHoldActivityHandle) { self.handle = handle }
    }

    init(
        host: any BatteryHoldActivityHost,
        api: any BatteryHoldActivityAPI,
        apnsEnvironment: ApnsEnvironment?,
        store: BatteryHoldActivityRegistrationStore,
        now: @escaping () -> Date = Date.init,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        signOutTimeout: Duration = .seconds(3)
    ) {
        self.signOutTimeout = signOutTimeout
        self.host = host
        self.api = api
        self.apnsEnvironment = apnsEnvironment
        self.store = store
        self.now = now
        self.sleep = sleep
    }

    func offer(forHoldID holdID: Int) -> BatteryHoldLiveActivityOffer {
        if shownHoldIDs.contains(holdID) { return .showing }
        return host.activitiesEnabled ? .available : .disabled
    }

    // MARK: Session

    /// The app verified the session and these sites. Ends activities for any
    /// other site, then reconciles the rest.
    func sitesAuthorized(_ sites: [MobileSite]) {
        sessionActive = true
        siteNames = Dictionary(sites.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        reconcileInBackground()
    }

    /// Foreground and relaunch: re-observe running activities, refresh their sites'
    /// holds, and unregister what was dismissed while the app was not running.
    func reconcileInBackground() {
        guard sessionActive else { return }
        Task { await reconcile() }
    }

    /// Unregisters while the session cookie still works, then clears every activity.
    func signOut() async {
        beginSessionChange()
        // A registration still in flight is removed after it lands, not before.
        let live = tracked.values.map {
            ($0.handle.attributes.siteID, $0.handle.attributes.registrationID, $0.registration)
        }
        let liveIDs = Set(live.map(\.1))
        let unique = live + store.entries.filter { !liveIDs.contains($0.registrationID) }
            .map { ($0.siteID, $0.registrationID, nil as Task<Void, Never>?) }
        let work = Task { [api] in
            await withTaskGroup(of: Void.self) { group in
                for (siteID, registrationID, registration) in unique {
                    group.addTask {
                        // At the timeout this child is cancelled; pass that on so a stalled
                        // request or retry wait stops rather than running on after sign-out.
                        await withTaskCancellationHandler {
                            await registration?.value
                        } onCancel: {
                            registration?.cancel()
                        }
                        try? await api.unregisterBatteryHoldActivity(siteID: siteID, registrationID: registrationID)
                    }
                }
            }
        }
        // Never hold up sign-out on the network for long. Leaving a task group waits
        // for every child, so the bound is a race outside it: whatever doesn't stop
        // on cancellation finishes in the background instead of holding logout.
        await Self.wait(for: work, atMost: signOutTimeout)
        work.cancel()
        await endEverything()
    }

    /// Returns when `work` finishes or `timeout` passes, whichever is first, without waiting for the other.
    static func wait(for work: Task<Void, Never>, atMost timeout: Duration) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let pending = OSAllocatedUnfairLock<CheckedContinuation<Void, Never>?>(initialState: continuation)
            let finish: @Sendable () -> Void = {
                pending.withLock { state -> CheckedContinuation<Void, Never>? in
                    defer { state = nil }
                    return state
                }?.resume()
            }
            Task { await work.value; finish() }
            Task { try? await Task.sleep(for: timeout); finish() }
        }
    }

    /// The session is already gone, so nothing can be unregistered; clear locally.
    func sessionInvalidated() async {
        beginSessionChange()
        await endEverything()
    }

    /// Stops observing without ending anything, as when the process exits.
    func stopObserving() {
        for item in tracked.values { item.observers.forEach { $0.cancel() } }
        tracked = [:]
        shownHoldIDs = []
    }

    @discardableResult
    func beginSessionChange() -> Int {
        generation += 1
        sessionActive = false
        siteNames = [:]
        return generation
    }

    func endEverything() async {
        stopObserving()
        store.clear()
        for handle in host.activities() { await handle.end(nil, immediately: true) }
    }

    // MARK: Confirmed hold state
}
