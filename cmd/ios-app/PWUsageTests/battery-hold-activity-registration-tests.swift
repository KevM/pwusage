import Foundation
@testable import PWUsage
import Testing

extension BatteryHoldActivityCoordinatorTests {
    @Test("A registration answered after sign-out is discarded and nothing is stored")
    func staleRegistration() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold())
        api.pauseRegistration = true
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { api.isPaused }
        await coordinator.sessionInvalidated()
        api.resume()
        try await eventually { handle.ends.first?.immediately == true }
        try await staysTrue { BatteryHoldActivityRegistrationStore(defaults: defaults).entries.isEmpty }
    }

    @Test("Refreshed server state updates, cancels and ends without regressing")
    func refreshed() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold(checkedAt: 900))
        // An older reading (a refresh that raced a push) never replaces a newer one.
        coordinator.batteryHoldConfirmed(.refreshed(.init(hold: hold(checkedAt: 0), notice: nil)),
                                         siteID: "site-1", timeZone: nil)
        // Another site's state never touches this site's activity.
        coordinator.batteryHoldConfirmed(.refreshed(.init(hold: nil, notice: nil)), siteID: "site-2", timeZone: nil)
        try await staysTrue { handle.updates.isEmpty && handle.ends.isEmpty }
        coordinator.batteryHoldConfirmed(.refreshed(.init(hold: hold(checkedAt: 1800), notice: nil)),
                                         siteID: "site-1", timeZone: nil)
        try await eventually { handle.updates.count == 1 }

        var cancelled = BatteryHold(id: 7, siteID: "site-1", status: .cancelled, mode: .auto,
                                    originalReserve: 20, targetReserve: 100,
                                    createdAt: start, safetyExpiresAt: start.addingTimeInterval(8 * 3600),
                                    cancelledObservedReserve: 45)
        cancelled.monitoring = nil
        coordinator.batteryHoldConfirmed(.refreshed(.init(hold: nil, notice: cancelled)),
                                         siteID: "site-1", timeZone: nil)
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
        let orphan = FakeActivityHandle(attributes: .init(siteID: "site-9", siteName: "Old",
                                                          holdID: 3, registrationID: UUID(),
                                                          timeZoneIdentifier: "UTC", activityStartedAt: start),
                                        state: .init(hold: hold(id: 3, site: "site-9")))
        host.handles.append(orphan)
        let dismissedID = UUID()
        BatteryHoldActivityRegistrationStore(defaults: defaults)
            .record(.init(registrationID: dismissedID, siteID: "site-2", holdID: 5, tokenDigest: "x"))

        // A new process: same host and store, no in-memory state.
        api.holdResponses["site-1"] = .init(hold: hold(checkedAt: 1800), notice: nil)
        let relaunched = BatteryHoldActivityCoordinator(
            host: host, api: api, apnsEnvironment: .sandbox,
            store: BatteryHoldActivityRegistrationStore(defaults: defaults),
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
        try await staysTrue { api.registerAttempts == 1 }
        api.resume()
        try await eventually { api.registrations.count == 2 }
        #expect(api.registrations.map { String($0.registration.pushToken.prefix(2)) } == ["aa", "bb"])
        // The stored digest is the newest token's: a relaunch doesn't re-send it.
        handle.emit(token: Data(repeating: 0xBB, count: 32))
        coordinator.stopObserving()
        let relaunched = makeCoordinator()
        _ = relaunched
        try await staysTrue { api.registrations.count == 2 }
    }

    @Test("A registration still in flight at sign-out is removed after it lands")
    func signOutDrainsRegistration() async throws {
        let coordinator = makeCoordinator()
        let handle = try await started(coordinator, hold())
        api.pauseRegistration = true
        handle.emit(token: Data(repeating: 1, count: 32))
        try await eventually { api.isPaused }
        let done = Flag()
        let signOut = Task { await coordinator.signOut(); done.value = true }
        // Sign-out waits for the in-flight registration instead of racing past it.
        try await staysTrue { !done.value }
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
        try await staysTrue { api.registerAttempts == 1 }
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
        try await staysTrue { new.ends.isEmpty && coordinator.offer(forHoldID: 8) == .showing }
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

    @Test("ActivityKit's states map to the coordinator's lifecycle; iOS 26's pending is not live")
    func lifecycleMapping() {
        #expect(ActivityKitBatteryHoldHandle.lifecycle(.active) == .active)
        #expect(ActivityKitBatteryHoldHandle.lifecycle(.stale) == .stale)
        #expect(ActivityKitBatteryHoldHandle.lifecycle(.ended) == .ended)
        #expect(ActivityKitBatteryHoldHandle.lifecycle(.dismissed) == .dismissed)
        if #available(iOS 26, *) {
            #expect(ActivityKitBatteryHoldHandle.lifecycle(.pending) == .pending)
        }
    }

    @Test("Reconcile leaves a pending activity alone, then adopts it once it is active")
    func pendingNotTracked() async throws {
        let pending = FakeActivityHandle(
            attributes: .init(siteID: "site-1", siteName: "Home", holdID: 7, registrationID: UUID(),
                              timeZoneIdentifier: "UTC", activityStartedAt: start),
            state: .init(hold: hold()))
        pending.lifecycle = .pending
        pending.pushToken = Data(repeating: 1, count: 32)
        host.handles.append(pending)
        api.holdResponses["site-1"] = .init(hold: hold(checkedAt: 300), notice: nil)
        let coordinator = makeCoordinator()
        try await staysTrue { pending.updates.isEmpty && pending.ends.isEmpty && api.registrations.isEmpty }
        pending.lifecycle = .active
        coordinator.reconcileInBackground()
        try await eventually { pending.updates.count == 1 && api.registrations.count == 1 }
        #expect(pending.ends.isEmpty)
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
        try await staysTrue { host.handles.count == 2 }
    }
}
