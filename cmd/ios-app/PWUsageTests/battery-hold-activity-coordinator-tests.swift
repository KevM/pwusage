import Foundation
import Testing
@testable import PWUsage

@MainActor
@Suite("Battery hold Live Activity lifecycle", .serialized, .timeLimit(.minutes(1)))
struct BatteryHoldActivityCoordinatorTests {
    private let host = FakeActivityHost()
    private let api = FakeActivityAPI()
    private let defaults = UserDefaults(suiteName: "activity-tests-\(UUID().uuidString)")!
    private let start = Date(timeIntervalSinceReferenceDate: 813751200)

    private func makeCoordinator(environment: ApnsEnvironment? = .sandbox,
                                 signOutTimeout: Duration = .seconds(3)) -> BatteryHoldActivityCoordinator {
        let coordinator = BatteryHoldActivityCoordinator(
            host: host, api: api, apnsEnvironment: environment,
            store: BatteryHoldActivityRegistrationStore(defaults: defaults),
            now: { [start] in start.addingTimeInterval(600) }, sleep: { _ in },
            signOutTimeout: signOutTimeout
        )
        coordinator.sitesAuthorized([MobileSite(id: "site-1", name: "Home", utility: "PGE"),
                                     MobileSite(id: "site-2", name: "Cabin", utility: "PGE")])
        return coordinator
    }

    private func hold(id: Int = 7, site: String = "site-1", mode: BatteryHoldMode = .auto,
                      checkedAt: TimeInterval? = nil, hours: Double = 8) -> BatteryHold {
        var hold = BatteryHold(id: id, siteID: site, status: .active, mode: mode, originalReserve: 20, targetReserve: 100,
                               createdAt: start, safetyExpiresAt: start.addingTimeInterval(hours * 3600),
                               cancelledObservedReserve: nil)
        if let checkedAt {
            hold.monitoring = .init(phase: .watching, checkedAt: start.addingTimeInterval(checkedAt),
                                    nextCheckAt: start.addingTimeInterval(checkedAt + 900), sampledAt: nil, estimatedLoadW: nil)
        }
        return hold
    }

    private func started(_ coordinator: BatteryHoldActivityCoordinator, _ hold: BatteryHold) async throws -> FakeActivityHandle {
        coordinator.batteryHoldConfirmed(.started(hold), siteID: hold.siteID, timeZone: "America/Los_Angeles")
        try await eventually { host.handles.contains { $0.attributes.holdID == hold.id } }
        return try #require(host.handles.last)
    }

    @Test("A confirmed start requests one token-push activity with the site and hold")
    func startsOnce() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold())
        #expect(handle.attributes.siteID == "site-1")
        #expect(handle.attributes.siteName == "Home")
        #expect(handle.attributes.timeZoneIdentifier == "America/Los_Angeles")
        #expect(handle.state == .init(hold: hold()))
        // A duplicate start (already_active, a second tap) reuses the activity.
        coordinator.batteryHoldConfirmed(.started(hold(checkedAt: 300)), siteID: "site-1", timeZone: nil)
        try await eventually { handle.updates.count == 1 }
        #expect(host.handles.count == 1)
        #expect(handle.state.checkedAt == start.addingTimeInterval(300))
        #expect(coordinator.offer(forHoldID: 7) == .showing)
    }

    @Test("Denied or failing Live Activities never throw into the hold")
    func deniedActivities() async throws {
        host.activitiesEnabled = false
        let coordinator = makeCoordinator()
        coordinator.batteryHoldConfirmed(.started(hold()), siteID: "site-1", timeZone: nil)
        try await Task.sleep(for: .milliseconds(20))
        #expect(host.handles.isEmpty)
        #expect(coordinator.offer(forHoldID: 7) == .disabled)
        host.activitiesEnabled = true
        host.startError = URLError(.unknown)
        coordinator.batteryHoldConfirmed(.started(hold()), siteID: "site-1", timeZone: nil)
        try await Task.sleep(for: .milliseconds(20))
        #expect(host.handles.isEmpty)
        #expect(coordinator.offer(forHoldID: 7) == .available)
    }

    @Test("Each push token is registered with its true environment; rotation re-registers")
    func registersTokens() async throws {
        let coordinator = makeCoordinator(environment: .production)
        let handle = try await started(coordinator, hold())
        handle.emit(token: Data([0xAB, 0x01] + Array(repeating: 0, count: 30)))
        try await eventually { api.registrations.count == 1 }
        let first = try #require(api.registrations.first)
        #expect(first.siteID == "site-1")
        #expect(first.registration.holdId == 7)
        #expect(first.registration.registrationId == handle.attributes.registrationID.uuidString.lowercased())
        #expect(first.registration.pushToken.hasPrefix("ab01"))
        #expect(first.registration.pushToken.count == 64)
        #expect(first.registration.apnsEnvironment == .production)
        // The same token again is not re-sent; a rotated one is.
        handle.emit(token: Data([0xAB, 0x01] + Array(repeating: 0, count: 30)))
        handle.emit(token: Data(repeating: 0xCD, count: 32))
        try await eventually { api.registrations.count == 2 }
        try await Task.sleep(for: .milliseconds(20))
        #expect(api.registrations.count == 2)
        #expect(api.registrations.last?.registration.pushToken.hasPrefix("cdcd") == true)
    }

    @Test("A build without an APNs environment shows the activity but never registers")
    func noEnvironment() async throws {
        let coordinator = makeCoordinator(environment: nil)
        let handle = try await started(coordinator, hold())
        handle.emit(token: Data(repeating: 1, count: 32))
        try await Task.sleep(for: .milliseconds(20))
        #expect(api.registrations.isEmpty)
    }

    @Test("Temporary registration failures retry; rejections stop")
    func retries() async throws {
        let coordinator = makeCoordinator()
        api.registerErrors = [PWUsageAPIError.recoverableServerError(statusCode: 503), URLError(.timedOut)]
        let handle = try await started(coordinator, hold())
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { api.registerAttempts == 3 }
        #expect(api.registrations.count == 1)

        api.registerErrors = [PWUsageAPIError.requestRejected(statusCode: 429, message: "registration_limit")]
        handle.emit(token: Data(repeating: 2, count: 32))
        try await eventually { api.registerAttempts == 4 }
        try await Task.sleep(for: .milliseconds(20))
        #expect(api.registerAttempts == 4)
        #expect(handle.lifecycle == .active)
    }

    @Test("Losing site access ends the activity immediately and unregisters it")
    func accessLost() async throws {
        let coordinator = makeCoordinator()
        api.registerErrors = [PWUsageAPIError.requestRejected(statusCode: 403, message: "Unauthorized")]
        let handle = try await started(coordinator, hold())
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { handle.ends.count == 1 }
        #expect(handle.ends.first?.immediately == true)
        try await eventually { api.removals.count == 1 }
        #expect(api.removals.first?.registrationID == handle.attributes.registrationID)
    }

    @Test("A registration answered after sign-out is discarded and nothing is stored")
    func staleRegistration() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold())
        api.pauseRegistration = true
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { api.isPaused }
        await coordinator.sessionInvalidated()
        api.resume()
        try await Task.sleep(for: .milliseconds(20))
        #expect(BatteryHoldActivityRegistrationStore(defaults: defaults).entries.isEmpty)
        #expect(handle.ends.first?.immediately == true)
    }

    @Test("Refreshed server state updates, cancels and ends without regressing")
    func refreshed() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold(checkedAt: 900))
        // An older reading (a refresh that raced a push) never replaces a newer one.
        coordinator.batteryHoldConfirmed(.refreshed(.init(hold: hold(checkedAt: 0), notice: nil)), siteID: "site-1", timeZone: nil)
        // Another site's state never touches this site's activity.
        coordinator.batteryHoldConfirmed(.refreshed(.init(hold: nil, notice: nil)), siteID: "site-2", timeZone: nil)
        try await Task.sleep(for: .milliseconds(20))
        #expect(handle.updates.isEmpty)
        #expect(handle.ends.isEmpty)
        coordinator.batteryHoldConfirmed(.refreshed(.init(hold: hold(checkedAt: 1800), notice: nil)), siteID: "site-1", timeZone: nil)
        try await eventually { handle.updates.count == 1 }

        var cancelled = BatteryHold(id: 7, siteID: "site-1", status: .cancelled, mode: .auto, originalReserve: 20, targetReserve: 100,
                                    createdAt: start, safetyExpiresAt: start.addingTimeInterval(8 * 3600), cancelledObservedReserve: 45)
        cancelled.monitoring = nil
        coordinator.batteryHoldConfirmed(.refreshed(.init(hold: nil, notice: cancelled)), siteID: "site-1", timeZone: nil)
        try await eventually { handle.ends.count == 1 }
        #expect(handle.ends[0].state?.status == .cancelled)
        #expect(handle.ends[0].state?.cancelledObservedReserve == 45)
        #expect(handle.ends[0].immediately == false)
    }

    @Test("A hold that disappears ends as 'ended', not as a claimed restoration")
    func disappeared() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold())
        coordinator.batteryHoldConfirmed(.refreshed(.init(hold: nil, notice: nil)), siteID: "site-1", timeZone: nil)
        try await eventually { handle.ends.count == 1 }
        #expect(handle.ends[0].state?.status == .ended)
    }

    @Test("Stopping in the app ends with a confirmed manual restore")
    func stopped() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold())
        coordinator.batteryHoldConfirmed(.stopped(holdID: 7), siteID: "site-1", timeZone: nil)
        try await eventually { handle.ends.count == 1 }
        #expect(handle.ends[0].state?.status == .restored)
        #expect(handle.ends[0].state?.restoreReason == .manual)
        #expect(handle.ends[0].state?.endedAt == start.addingTimeInterval(600))
    }

    @Test("A newer hold on the same site ends the older hold's activity")
    func newerHold() async throws {
        let coordinator = makeCoordinator()
        let old = try await started(coordinator, hold(id: 7))
        _ = try await started(coordinator, hold(id: 8))
        try await eventually { old.ends.count == 1 }
        #expect(host.handles.count == 2)
        // Removed from the Lock Screen, not left beside the new hold's activity.
        #expect(old.ends.first?.immediately == true)
    }

    @Test("A new hold dismisses the site's finished activity still on the Lock Screen")
    func newHoldDismissesFinished() async throws {
        let coordinator = makeCoordinator()
        let finished = try await started(coordinator, hold(id: 7))
        // The server's end push finished it; it stays visible under the default policy.
        await finished.end(finished.state.ended(as: .restored, reason: .loadEnded, at: start), immediately: false)
        try await eventually { coordinator.offer(forHoldID: 7) == .available }
        let other = try await started(coordinator, hold(id: 9, site: "site-2"))
        _ = try await started(coordinator, hold(id: 8))
        try await eventually { finished.ends.count == 2 }
        #expect(finished.ends.count == 2)
        #expect(finished.ends.last?.immediately == true)
        #expect(other.ends.isEmpty)
    }

    @Test("Dismissal is observed and unregisters the activity")
    func dismissal() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold())
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { api.registrations.count == 1 }
        handle.dismiss()
        try await eventually { api.removals.count == 1 }
        #expect(BatteryHoldActivityRegistrationStore(defaults: defaults).entries.isEmpty)
        #expect(coordinator.offer(forHoldID: 7) == .available)
    }

    @Test("Relaunch reconciles: re-observes activities, refreshes their sites and cleans up the rest")
    func relaunch() async throws {
        let first = makeCoordinator()
        let handle = try await started(first, hold())
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { api.registrations.count == 1 }
        first.stopObserving() // the process exits
        let orphan = FakeActivityHandle(attributes: .init(siteID: "site-9", siteName: "Old", holdID: 3, registrationID: UUID(),
                                                          timeZoneIdentifier: "UTC", activityStartedAt: start),
                                        state: .init(hold: hold(id: 3, site: "site-9")))
        host.handles.append(orphan)
        let dismissedID = UUID()
        BatteryHoldActivityRegistrationStore(defaults: defaults)
            .record(.init(registrationID: dismissedID, siteID: "site-2", holdID: 5, tokenDigest: "x"))

        // A new process: same host and store, no in-memory state.
        api.holdResponses["site-1"] = .init(hold: hold(checkedAt: 1800), notice: nil)
        let relaunched = BatteryHoldActivityCoordinator(
            host: host, api: api, apnsEnvironment: .sandbox, store: BatteryHoldActivityRegistrationStore(defaults: defaults),
            now: { [start] in start.addingTimeInterval(2000) }, sleep: { _ in })
        relaunched.sitesAuthorized([MobileSite(id: "site-1", name: "Home", utility: "PGE"),
                                    MobileSite(id: "site-2", name: "Cabin", utility: "PGE")])
        try await eventually { handle.updates.count == 1 && orphan.ends.count == 1 && api.removals.count == 2 }
        #expect(orphan.ends[0].immediately)
        #expect(Set(api.removals.map(\.registrationID)) == [orphan.attributes.registrationID, dismissedID])
        // The known token is not re-sent; a rotation after relaunch still is.
        #expect(api.registrations.count == 1)
        handle.emit(token: Data(repeating: 2, count: 32))
        try await eventually { api.registrations.count == 2 }
    }

    @Test("A rotation while a registration is in flight is sent after it, so the newest token wins")
    func serializedRotation() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold())
        api.pauseRegistration = true
        handle.emit(token: Data(repeating: 0xAA, count: 32))
        try await eventually { api.isPaused }
        handle.emit(token: Data(repeating: 0xBB, count: 32))
        try await Task.sleep(for: .milliseconds(20))
        #expect(api.registerAttempts == 1)
        api.resume()
        try await eventually { api.registrations.count == 2 }
        #expect(api.registrations.map { String($0.registration.pushToken.prefix(2)) } == ["aa", "bb"])
        // The stored digest is the newest token's: a relaunch doesn't re-send it.
        handle.emit(token: Data(repeating: 0xBB, count: 32))
        coordinator.stopObserving()
        let relaunched = makeCoordinator()
        _ = relaunched
        try await Task.sleep(for: .milliseconds(20))
        #expect(api.registrations.count == 2)
    }

    @Test("A registration still in flight at sign-out is removed after it lands")
    func signOutDrainsRegistration() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold())
        api.pauseRegistration = true
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { api.isPaused }
        let signOut = Task { await coordinator.signOut() }
        try await Task.sleep(for: .milliseconds(20))
        api.resume()
        await signOut.value
        #expect(api.events == ["register", "remove"])
    }

    @Test("Sign-out is bounded by its timeout even when a registration never answers")
    func signOutTimeoutBounds() async throws {
        let coordinator = makeCoordinator(signOutTimeout: .milliseconds(50))
        let handle = try await started(coordinator, hold())
        api.pauseRegistration = true
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { api.isPaused }
        let done = Flag()
        Task { await coordinator.signOut(); done.value = true }
        try await eventually { done.value }
        #expect(done.value)
        #expect(handle.ends.first?.immediately == true)
        api.resume()
    }

    @Test("Sign-out stays bounded and stops every queued registration when a token rotated mid-request")
    func signOutBoundsQueuedRegistrations() async throws {
        let coordinator = makeCoordinator(signOutTimeout: .milliseconds(50))
        let handle = try await started(coordinator, hold())
        api.pauseRegistration = true
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { api.isPaused }
        // The rotated token's registration queues behind the stalled one.
        handle.emit(token: Data(repeating: 2, count: 32))
        try await Task.sleep(for: .milliseconds(10))
        let done = Flag()
        Task { await coordinator.signOut(); done.value = true }
        try await eventually { done.value }
        #expect(done.value)
        #expect(handle.ends.first?.immediately == true)
        // Cancellation reached the stalled request behind the queued one.
        try await eventually { api.cancelledRegistrations == 1 }
        #expect(api.cancelledRegistrations == 1)
        #expect(api.registrations.isEmpty)
    }

    @Test("A site read that started before a new hold can't end the new hold's activity")
    func staleReconcileSparesNewActivity() async throws {
        let coordinator = makeCoordinator()
        let old = try await started(coordinator, hold(id: 7))
        api.pauseFetch = true
        api.holdResponses["site-1"] = .init(hold: hold(id: 7), notice: nil)
        coordinator.reconcileInBackground()
        try await eventually { api.isFetchPaused }
        let new = try await started(coordinator, hold(id: 8))
        try await eventually { old.ends.count == 1 }
        api.holdResponses["site-1"] = .init(hold: hold(id: 8), notice: nil)
        api.resumeFetch()
        try await Task.sleep(for: .milliseconds(30))
        #expect(new.ends.isEmpty)
        #expect(coordinator.offer(forHoldID: 8) == .showing)
    }

    @Test("A start before relaunch reconcile reaches an existing activity adopts it")
    func adoptsBeforeReconcile() async throws {
        let existing = FakeActivityHandle(
            attributes: .init(siteID: "site-1", siteName: "Home", holdID: 7, registrationID: UUID(),
                              timeZoneIdentifier: "UTC", activityStartedAt: start),
            state: .init(hold: hold()))
        host.handles.append(existing)
        let coordinator = makeCoordinator()
        coordinator.show(hold(checkedAt: 300), siteID: "site-1", timeZone: nil)
        try await eventually { existing.updates.count == 1 }
        #expect(host.handles.count == 1)
        #expect(coordinator.offer(forHoldID: 7) == .showing)
    }

    @Test("Sign-out unregisters, then clears every activity from the Lock Screen")
    func signOut() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold())
        let other = try await started(coordinator, hold(id: 9, site: "site-2"))
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { api.registrations.count == 1 }
        await coordinator.signOut()
        #expect(api.removals.map(\.registrationID).contains(handle.attributes.registrationID))
        #expect(handle.ends.first?.immediately == true)
        #expect(other.ends.first?.immediately == true)
        #expect(BatteryHoldActivityRegistrationStore(defaults: defaults).entries.isEmpty)
        coordinator.batteryHoldConfirmed(.started(hold(id: 10)), siteID: "site-1", timeZone: nil)
        try await Task.sleep(for: .milliseconds(20))
        #expect(host.handles.count == 2)
    }

    @Test("The eventually helper fails rather than returning after its deadline")
    func eventuallyTimesOut() async {
        await #expect(throws: TestWaitTimeout.self) {
            try await eventually(timeout: .milliseconds(50)) { false }
        }
    }
}

private struct TestWaitTimeout: Error { let message: String }

@MainActor
func eventually(
    timeout: Duration = .seconds(2),
    _ condition: @MainActor () -> Bool
) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(10))
    }
    if condition() { return }
    throw TestWaitTimeout(message: "Timed out after \(timeout) waiting for condition")
}

@MainActor
final class FakeActivityHandle: BatteryHoldActivityHandle {
    struct End { let state: BatteryHoldActivityAttributes.ContentState?; let immediately: Bool }
    let id = UUID().uuidString
    let attributes: BatteryHoldActivityAttributes
    var state: BatteryHoldActivityAttributes.ContentState
    var lifecycle: BatteryHoldActivityLifecycle = .active
    var pushToken: Data?
    var updates: [BatteryHoldActivityAttributes.ContentState] = []
    var ends: [End] = []
    // Fan out to every observer, as ActivityKit's sequences do for each caller.
    private var tokenObservers: [AsyncStream<Data>.Continuation] = []
    private var lifecycleObservers: [AsyncStream<BatteryHoldActivityLifecycle>.Continuation] = []

    init(attributes: BatteryHoldActivityAttributes, state: BatteryHoldActivityAttributes.ContentState) {
        self.attributes = attributes
        self.state = state
    }

    func pushTokenUpdates() -> AsyncStream<Data> {
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        tokenObservers.append(continuation)
        return stream
    }
    func lifecycleUpdates() -> AsyncStream<BatteryHoldActivityLifecycle> {
        let (stream, continuation) = AsyncStream<BatteryHoldActivityLifecycle>.makeStream()
        lifecycleObservers.append(continuation)
        return stream
    }
    func update(_ state: BatteryHoldActivityAttributes.ContentState) async {
        self.state = state
        updates.append(state)
    }
    func end(_ state: BatteryHoldActivityAttributes.ContentState?, immediately: Bool) async {
        if let state { self.state = state }
        ends.append(End(state: state, immediately: immediately))
        set(immediately ? .dismissed : .ended)
    }
    func emit(token: Data) {
        pushToken = token
        tokenObservers.forEach { $0.yield(token) }
    }
    func dismiss() { set(.dismissed) }
    private func set(_ value: BatteryHoldActivityLifecycle) {
        lifecycle = value
        lifecycleObservers.forEach { $0.yield(value) }
    }
}

@MainActor
final class FakeActivityHost: BatteryHoldActivityHost {
    var activitiesEnabled = true
    var startError: (any Error)?
    var handles: [FakeActivityHandle] = []

    func activities() -> [any BatteryHoldActivityHandle] { handles }
    func start(attributes: BatteryHoldActivityAttributes,
               state: BatteryHoldActivityAttributes.ContentState) throws -> any BatteryHoldActivityHandle {
        if let startError { throw startError }
        let handle = FakeActivityHandle(attributes: attributes, state: state)
        handles.append(handle)
        return handle
    }
}

@MainActor
final class FakeActivityAPI: BatteryHoldActivityAPI {
    struct Registered { let siteID: String; let registration: BatteryHoldActivityRegistration }
    struct Removed { let siteID: String; let registrationID: UUID }
    var registrations: [Registered] = []
    /// Completed calls in order.
    var events: [String] = []
    var removals: [Removed] = []
    var registerAttempts = 0
    var registerErrors: [any Error] = []
    var holdResponses: [String: BatteryHoldResponse] = [:]
    var pauseRegistration = false
    private(set) var isPaused = false
    private(set) var cancelledRegistrations = 0
    var pauseFetch = false
    private(set) var isFetchPaused = false

    func fetchBatteryHold(siteID: String) async throws -> BatteryHoldResponse {
        // The answer as of when the read began, as a real request would have it.
        let response = holdResponses[siteID]
        if pauseFetch {
            pauseFetch = false
            isFetchPaused = true
            while isFetchPaused { try await Task.sleep(for: .milliseconds(2)) }
        }
        guard let response else { throw URLError(.notConnectedToInternet) }
        return response
    }
    func registerBatteryHoldActivity(siteID: String, registration: BatteryHoldActivityRegistration) async throws {
        registerAttempts += 1
        if pauseRegistration {
            pauseRegistration = false
            isPaused = true
            // Like URLSession, a paused request gives up when its task is cancelled.
            do { while isPaused { try await Task.sleep(for: .milliseconds(2)) } }
            catch { cancelledRegistrations += 1; throw error }
        }
        if !registerErrors.isEmpty { throw registerErrors.removeFirst() }
        registrations.append(.init(siteID: siteID, registration: registration))
        events.append("register")
    }
    func unregisterBatteryHoldActivity(siteID: String, registrationID: UUID) async throws {
        removals.append(.init(siteID: siteID, registrationID: registrationID))
        events.append("remove")
    }
    func resume() { isPaused = false }
    func resumeFetch() { isFetchPaused = false }
}

@MainActor
final class Flag { var value = false }
