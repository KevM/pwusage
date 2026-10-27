import CryptoKit
import Foundation
import Observation
import os
import OSLog

/// The APNs environment a build's `aps-environment` entitlement selects. The
/// server keeps sandbox and production registrations apart and accepts
/// production only from the production deployment.
enum ApnsEnvironment: String, Codable, Sendable {
    case sandbox, production

    /// Reads `PWUSAGE_APS_ENVIRONMENT`, which project.yml sets from the same build
    /// setting as the entitlement, so the two cannot disagree.
    static func fromBundle(_ bundle: Bundle = .main) -> Self? {
        switch bundle.object(forInfoDictionaryKey: "PWUSAGE_APS_ENVIRONMENT") as? String {
        case "development": .sandbox
        case "production": .production
        default: nil
        }
    }
}

struct BatteryHoldActivityRegistration: Encodable, Equatable, Sendable {
    let holdId: Int
    let registrationId: String
    let pushToken: String
    let apnsEnvironment: ApnsEnvironment
}

protocol BatteryHoldActivityAPI: Sendable {
    func fetchBatteryHold(siteID: String) async throws -> BatteryHoldResponse
    func registerBatteryHoldActivity(siteID: String, registration: BatteryHoldActivityRegistration) async throws
    func unregisterBatteryHoldActivity(siteID: String, registrationID: UUID) async throws
}

/// `pending` is an activity iOS has accepted but not yet shown (iOS 26 scheduled
/// starts). The app never schedules one, so it is neither tracked as live nor
/// ended: a later reconcile adopts it once it is active.
enum BatteryHoldActivityLifecycle: Equatable, Sendable { case pending, active, stale, ended, dismissed }

/// One running Live Activity. ActivityKit in the app; a fake in tests.
@MainActor
protocol BatteryHoldActivityHandle: AnyObject {
    var id: String { get }
    var attributes: BatteryHoldActivityAttributes { get }
    var state: BatteryHoldActivityAttributes.ContentState { get }
    var lifecycle: BatteryHoldActivityLifecycle { get }
    var pushToken: Data? { get }
    func pushTokenUpdates() -> AsyncStream<Data>
    func lifecycleUpdates() -> AsyncStream<BatteryHoldActivityLifecycle>
    func update(_ state: BatteryHoldActivityAttributes.ContentState) async
    /// `immediately` removes it from the Lock Screen; otherwise the final state stays until the person or system removes it.
    func end(_ state: BatteryHoldActivityAttributes.ContentState?, immediately: Bool) async
}

@MainActor
protocol BatteryHoldActivityHost: AnyObject {
    var activitiesEnabled: Bool { get }
    func activities() -> [any BatteryHoldActivityHandle]
    func start(attributes: BatteryHoldActivityAttributes,
               state: BatteryHoldActivityAttributes.ContentState) throws -> any BatteryHoldActivityHandle
}

/// Confirmed server state the dashboard reports, for the selected site.
enum BatteryHoldConfirmation {
    /// A database read of the site's hold status.
    case refreshed(BatteryHoldResponse)
    /// The person confirmed a start in this app and the server accepted it.
    case started(BatteryHold)
    /// The server accepted this app's stop and restored the original reserve.
    case stopped(holdID: Int)
}

@MainActor
protocol BatteryHoldActivityObserving: AnyObject {
    func batteryHoldConfirmed(_ confirmation: BatteryHoldConfirmation, siteID: String, timeZone: String?)
}

/// Registrations this device made, so the app can unregister them after a
/// dismissal it did not observe. Stores a digest of the token, never the token.
struct BatteryHoldActivityRegistrationStore {
    struct Entry: Codable, Equatable {
        let registrationID: UUID
        let siteID: String
        let holdID: Int
        let tokenDigest: String
    }

    private static let key = "pwusage.batteryHoldActivityRegistrations"
    let defaults: UserDefaults

    var entries: [Entry] {
        guard let data = defaults.data(forKey: Self.key),
              let entries = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
        return entries
    }

    func entry(_ registrationID: UUID) -> Entry? { entries.first { $0.registrationID == registrationID } }

    func record(_ entry: Entry) {
        save(entries.filter { $0.registrationID != entry.registrationID } + [entry])
    }

    func remove(_ registrationID: UUID) { save(entries.filter { $0.registrationID != registrationID }) }

    func clear() { defaults.removeObject(forKey: Self.key) }

    private func save(_ entries: [Entry]) {
        if entries.isEmpty { clear() } else { defaults.set(try? JSONEncoder().encode(entries), forKey: Self.key) }
    }
}

enum BatteryHoldLiveActivityOffer: Equatable {
    /// Live Activities are off for pwusage, or unsupported.
    case disabled
    /// No activity follows this hold here; the person may start one.
    case available
    case showing
}

/// Starts, registers, reconciles and ends battery hold Live Activities.
///
/// Nothing here can affect a hold: every failure is logged and absorbed, and
/// the only server writes are this device's own push-token registrations.
@MainActor
@Observable
final class BatteryHoldActivityCoordinator: BatteryHoldActivityObserving {
    /// Holds this device currently shows, for the sheet's offer.
    private(set) var shownHoldIDs: Set<Int> = []

    @ObservationIgnored private let host: any BatteryHoldActivityHost
    @ObservationIgnored private let api: any BatteryHoldActivityAPI
    @ObservationIgnored private let apnsEnvironment: ApnsEnvironment?
    @ObservationIgnored private let store: BatteryHoldActivityRegistrationStore
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private let signOutTimeout: Duration
    @ObservationIgnored private let logger = Logger(subsystem: "fm.rodeo.pwusage", category: "battery-hold-activity")
    @ObservationIgnored private var siteNames: [String: String] = [:]
    @ObservationIgnored private var tracked: [String: Tracked] = [:]
    /// Bumped on sign-out and session loss, so late responses change nothing.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var sessionActive = false
    @ObservationIgnored private var isReconciling = false
    @ObservationIgnored private var reconcileRequested = false

    static let retryDelays: [Duration] = [.seconds(2), .seconds(10), .seconds(30)]

    private final class Tracked {
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
    private static func wait(for work: Task<Void, Never>, atMost timeout: Duration) async {
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
    private func beginSessionChange() -> Int {
        generation += 1
        sessionActive = false
        siteNames = [:]
        return generation
    }

    private func endEverything() async {
        stopObserving()
        store.clear()
        for handle in host.activities() { await handle.end(nil, immediately: true) }
    }

    // MARK: Confirmed hold state

    func batteryHoldConfirmed(_ confirmation: BatteryHoldConfirmation, siteID: String, timeZone: String?) {
        guard sessionActive else { return }
        switch confirmation {
        case .started(let hold):
            start(hold, siteID: siteID, timeZone: timeZone)
        case .refreshed(let response):
            let current = activityIDs(siteID: siteID)
            Task { await apply(response, siteID: siteID, to: current) }
        case .stopped(let holdID):
            Task {
                for item in trackedItems(siteID: siteID) where item.handle.attributes.holdID == holdID {
                    await end(item, as: item.handle.state.ended(as: .restored, reason: .manual, at: now()))
                }
            }
        }
    }

    /// The sheet's offer, for a hold started elsewhere or whose activity was dismissed.
    func show(_ hold: BatteryHold, siteID: String, timeZone: String?) {
        guard sessionActive else { return }
        start(hold, siteID: siteID, timeZone: timeZone)
    }

    private func start(_ hold: BatteryHold, siteID: String, timeZone: String?) {
        guard hold.status == .active, hold.siteID == siteID, let siteName = siteNames[siteID] else { return }
        let state = BatteryHoldActivityAttributes.ContentState(hold: hold)
        // An activity from before a relaunch that reconcile hasn't reached yet.
        for handle in host.activities() where handle.attributes.siteID == siteID && handle.attributes.holdID == hold.id
            && (handle.lifecycle == .active || handle.lifecycle == .stale) {
            track(handle)
        }
        if let existing = trackedItems(siteID: siteID).first(where: { $0.handle.attributes.holdID == hold.id }) {
            Task { await update(existing, to: state) }
            return
        }
        // A site shows one hold. Anything else for it is over, including a finished
        // activity still on the Lock Screen, so remove it rather than leave two.
        let others = host.activities().filter { $0.attributes.siteID == siteID && $0.attributes.holdID != hold.id }
        Task {
            for handle in others {
                if let item = tracked[handle.id] { await end(item, as: nil, immediately: true) }
                else { await handle.end(nil, immediately: true) }
            }
        }
        guard host.activitiesEnabled else { return }
        let attributes = BatteryHoldActivityAttributes(
            siteID: siteID, siteName: siteName, holdID: hold.id, registrationID: UUID(),
            timeZoneIdentifier: timeZone ?? TimeZone.current.identifier, activityStartedAt: now()
        )
        do {
            track(try host.start(attributes: attributes, state: state))
        } catch {
            logger.error("Live Activity start failed: \(String(describing: type(of: error)), privacy: .public)")
        }
    }

    /// Applies a site read to the activities that existed when it was taken. One
    /// started since is newer than the read, which mustn't end it.
    private func apply(_ response: BatteryHoldResponse, siteID: String, to activityIDs: Set<String>) async {
        for item in trackedItems(siteID: siteID) where activityIDs.contains(item.handle.id) {
            let holdID = item.handle.attributes.holdID
            if let hold = response.hold, hold.id == holdID {
                await update(item, to: .init(hold: hold))
            } else if let notice = response.notice, notice.id == holdID {
                await end(item, as: item.handle.state.ended(
                    as: .cancelled, reason: .reserveChanged, at: now(), observedReserve: notice.cancelledObservedReserve))
            } else {
                // Restored, or replaced by a newer hold. This read doesn't say which,
                // so the activity doesn't claim a restoration it hasn't seen.
                await end(item, as: item.handle.state.ended(as: .ended, at: now()))
            }
        }
    }

    private func update(_ item: Tracked, to state: BatteryHoldActivityAttributes.ContentState) async {
        let current = item.handle.state
        // A push may already have delivered something newer than this read.
        guard state != current, state.dataTime >= current.dataTime, current.status == .active else { return }
        await item.handle.update(state)
    }

    // MARK: Tracking

    private func trackedItems(siteID: String) -> [Tracked] {
        tracked.values.filter { $0.handle.attributes.siteID == siteID }
    }

    private func track(_ handle: any BatteryHoldActivityHandle) {
        guard tracked[handle.id] == nil else { return }
        let item = Tracked(handle: handle)
        let activityID = handle.id
        let tokens = handle.pushTokenUpdates()
        let lifecycles = handle.lifecycleUpdates()
        item.observers = [
            Task { [weak self] in
                for await token in tokens { self?.tokenReceived(token, activityID: activityID) }
            },
            Task { [weak self] in
                for await lifecycle in lifecycles where lifecycle == .ended || lifecycle == .dismissed {
                    await self?.observedEnd(activityID: activityID)
                }
            },
        ]
        tracked[activityID] = item
        shownHoldIDs.insert(handle.attributes.holdID)
        if let token = handle.pushToken { tokenReceived(token, activityID: activityID) }
    }

    private func untrack(_ activityID: String) -> Tracked? {
        guard let item = tracked.removeValue(forKey: activityID) else { return nil }
        item.observers.forEach { $0.cancel() }
        shownHoldIDs = Set(tracked.values.map(\.handle.attributes.holdID))
        return item
    }

    private func end(_ item: Tracked, as state: BatteryHoldActivityAttributes.ContentState?, immediately: Bool = false) async {
        guard untrack(item.handle.id) != nil else { return }
        await item.handle.end(state, immediately: immediately)
        await unregister(item.handle.attributes)
    }

    private func observedEnd(activityID: String) async {
        guard let item = untrack(activityID) else { return }
        await unregister(item.handle.attributes)
    }

    // MARK: Registration

    private func tokenReceived(_ token: Data, activityID: String) {
        guard let item = tracked[activityID], item.latestToken != token else { return }
        item.latestToken = token
        // One at a time per activity: an older token's request can't land after a newer one's.
        let previous = item.registration
        item.registration = Task {
            // Cancelling the newest registration (sign-out) cancels the queue behind it.
            await withTaskCancellationHandler {
                await previous?.value
            } onCancel: {
                previous?.cancel()
            }
            guard !Task.isCancelled else { return }
            await register(token, activityID: activityID)
        }
    }

    private func register(_ token: Data, activityID: String) async {
        guard let apnsEnvironment, let item = tracked[activityID] else { return }
        let attributes = item.handle.attributes
        let digest = SHA256.hash(data: token).map { String(format: "%02x", $0) }.joined()
        if store.entry(attributes.registrationID)?.tokenDigest == digest { return }
        let registration = BatteryHoldActivityRegistration(
            holdId: attributes.holdID,
            registrationId: attributes.registrationID.uuidString.lowercased(),
            pushToken: token.map { String(format: "%02x", $0) }.joined(),
            apnsEnvironment: apnsEnvironment
        )
        let generation = generation
        for attempt in 0...Self.retryDelays.count {
            // A rotated token or ended activity makes this attempt pointless.
            guard generation == self.generation, tracked[activityID]?.latestToken == token else { return }
            do {
                try await api.registerBatteryHoldActivity(siteID: attributes.siteID, registration: registration)
                guard generation == self.generation else { return }
                store.record(.init(registrationID: attributes.registrationID, siteID: attributes.siteID,
                                   holdID: attributes.holdID, tokenDigest: digest))
                // Ended while the request was in flight: don't leave it registered.
                if tracked[activityID] == nil { await unregister(attributes) }
                return
            } catch let error as PWUsageAPIError {
                guard generation == self.generation else { return }
                switch error {
                case .signInRequired:
                    return
                case .requestRejected(403, _):
                    // Access to this site is gone: clear its private presentation.
                    if let item = tracked[activityID] { await end(item, as: nil, immediately: true) }
                    return
                case .requestRejected(404, _), .requestRejected(410, _):
                    // The hold ended or this registration was retired; the site's status says which.
                    await refreshSite(attributes.siteID)
                    return
                case .requestRejected(let status, let message):
                    logger.error("Live Activity registration rejected: \(status, privacy: .public) \(message ?? "", privacy: .public)")
                    return
                case .recoverableServerError, .invalidResponse:
                    break
                }
            } catch {
                guard generation == self.generation else { return }
            }
            guard attempt < Self.retryDelays.count else { break }
            do { try await sleep(Self.retryDelays[attempt]) } catch { return }
        }
        logger.error("Live Activity registration failed after retries; next foreground reconcile retries")
        tracked[activityID]?.latestToken = nil
    }

    private func unregister(_ attributes: BatteryHoldActivityAttributes) async {
        await unregister(siteID: attributes.siteID, registrationID: attributes.registrationID)
    }

    private func unregister(siteID: String, registrationID: UUID) async {
        let generation = generation
        guard sessionActive else { return }
        do {
            try await api.unregisterBatteryHoldActivity(siteID: siteID, registrationID: registrationID)
            guard generation == self.generation else { return }
            store.remove(registrationID)
        } catch PWUsageAPIError.requestRejected {
            guard generation == self.generation else { return }
            store.remove(registrationID)
        } catch {
            // Kept for the next reconcile; expiry and invalid-token cleanup cover the rest.
        }
    }

    // MARK: Reconcile

    private func reconcile() async {
        // A request that arrives mid-run (new sites, say) runs again rather than being dropped.
        reconcileRequested = true
        guard !isReconciling else { return }
        isReconciling = true
        defer { isReconciling = false }
        while reconcileRequested, sessionActive {
            reconcileRequested = false
            await reconcileOnce()
        }
    }

    private func reconcileOnce() async {
        let generation = generation
        let running = host.activities()
        for handle in running {
            let attributes = handle.attributes
            if siteNames[attributes.siteID] == nil {
                _ = untrack(handle.id)
                await handle.end(nil, immediately: true)
                await unregister(attributes)
            } else if handle.lifecycle == .pending {
                continue
            } else if handle.lifecycle == .active || handle.lifecycle == .stale {
                track(handle)
                // Retries a registration that gave up, or a token rotated while suspended.
                if let token = handle.pushToken { tokenReceived(token, activityID: handle.id) }
            } else {
                _ = untrack(handle.id)
                if store.entry(attributes.registrationID) != nil { await unregister(attributes) }
            }
            guard generation == self.generation else { return }
        }
        let live = Set(tracked.values.map(\.handle.attributes.registrationID))
        for entry in store.entries where !live.contains(entry.registrationID) {
            await unregister(siteID: entry.siteID, registrationID: entry.registrationID)
            guard generation == self.generation else { return }
        }
        // Reads the database-backed status only; never a Tesla request.
        for siteID in Set(tracked.values.map(\.handle.attributes.siteID)) {
            await refreshSite(siteID)
            guard generation == self.generation else { return }
        }
    }

    private func refreshSite(_ siteID: String) async {
        let generation = generation
        let current = activityIDs(siteID: siteID)
        guard let response = try? await api.fetchBatteryHold(siteID: siteID).validating(siteID: siteID),
              generation == self.generation, sessionActive else { return }
        await apply(response, siteID: siteID, to: current)
    }

    private func activityIDs(siteID: String) -> Set<String> {
        Set(trackedItems(siteID: siteID).map(\.handle.id))
    }
}
