import AuthenticationServices
import Foundation
@testable import PWUsage
import Testing

extension PWUsageAppModelTests {
    @Test("Signing out runs session cleanup")
    func signOutUsesSessionCleanup() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        final class CleanupSpy: @unchecked Sendable { var count = 0 }
        let spy = CleanupSpy()
        var cleanup = SolarSessionCleanup()
        cleanup.additionalCleanup = { spy.count += 1 }
        let model = PWUsageAppModel(
            configuration: try Self.makeConfiguration(),
            api: api,
            userDefaults: makeDefaults(),
            sessionCleanup: cleanup
        )

        await model.bootstrap()
        await model.signOut()

        #expect(spy.count == 1)
    }

    @Test("A failing forecast sign-out is reported to the user instead of silently ignored")
    func forecastSignOutFailureSurfaces() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        var cleanup = SolarSessionCleanup()
        cleanup.additionalCleanup = { throw PWUsageAPIError.invalidResponse }
        let model = PWUsageAppModel(
            configuration: try Self.makeConfiguration(),
            api: api,
            userDefaults: makeDefaults(),
            sessionCleanup: cleanup
        )

        await model.bootstrap()
        try #require(model.signInMessage == nil)
        await model.signOut()

        #expect(model.signInMessage?.contains("Could not clear local solar forecast data") == true)
        #expect(model.screenState == .signedOut)
    }

    @Test("Signing out stops the coordinator so a later timer tick issues no request")
    func signOutStopsTheCoordinatorSoNoRequestFollowsTheSignOut() async throws {
        let clock = AppTestClock()
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let model = try makeModel(
            api: api,
            timerInterval: .milliseconds(20),
            now: { clock.now }
        )
        model.scenePhaseChanged(isActive: true)
        await model.bootstrap()
        try await waitForDashboardRequests(api)

        let coordinator = try #require(model.coordinator)
        #expect(coordinator.pollingTimerIsActive)
        let liveBeforeSignOut = api.liveSiteIDs.count
        let billBeforeSignOut = api.billSiteIDs.count

        await model.signOut()

        #expect(!coordinator.pollingTimerIsActive, "The orphaned coordinator must not keep polling after sign-out.")
        #expect(!coordinator.isForeground)
        // Both endpoints are now well past their cadence, so a surviving timer
        // would immediately issue another authenticated-shaped request.
        clock.advance(minutes: 10)
        try await Task.sleep(for: .milliseconds(300))
        #expect(api.liveSiteIDs.count == liveBeforeSignOut)
        #expect(api.billSiteIDs.count == billBeforeSignOut)
    }

    @Test("Signing out does not flash an expired-session message during cleanup")
    func signOutDoesNotFlashExpiredSessionMessage() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        api.holdLogout = true
        let model = try makeModel(api: api)
        await model.bootstrap()

        let signOut = Task { await model.signOut() }
        try await waitUntil { api.logoutStarted }

        #expect(model.isSigningOut)
        #expect(model.screenState == .signedOut)
        #expect(model.signInMessage == nil)

        api.resumeLogout()
        await signOut.value

        #expect(!model.isSigningOut)
        #expect(model.screenState == .signedOut)
        #expect(model.signInMessage == nil)
    }

    @Test("Sign-in is blocked while sign-out cleanup is still running")
    func signInBlockedWhileSigningOut() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        api.holdLogout = true
        let model = try makeModel(api: api)
        await model.bootstrap()

        let signOut = Task { await model.signOut() }
        try await waitUntil { api.logoutStarted }

        #expect(model.isSigningOut)
        #expect(model.screenState == .signedOut)

        let initialSiteFetches = api.siteFetchCount
        await model.signIn()

        #expect(model.isSigningOut)
        #expect(!model.isSigningIn)
        #expect(api.siteFetchCount == initialSiteFetches)

        api.resumeLogout()
        await signOut.value

        #expect(!model.isSigningOut)
        #expect(model.screenState == .signedOut)
        #expect(model.coordinator == nil)
    }

    @Test("Session expiry notifications are suppressed while sign-out cleanup is running")
    func sessionExpirySuppressedWhileSigningOut() async throws {
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        api.holdLogout = true
        let model = try makeModel(api: api)
        await model.bootstrap()

        let signOut = Task { await model.signOut() }
        try await waitUntil { api.logoutStarted }

        await model.sessionExpired()

        #expect(model.signInMessage == nil)

        api.resumeLogout()
        await signOut.value

        #expect(model.signInMessage == nil)
    }

    @Test("A live response that lands after sign-out does not repopulate the coordinator")
    func lateLiveResponseAfterSignOutDoesNotRepopulateState() async throws {
        let clock = AppTestClock()
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        api.holdLive = true
        let model = try makeModel(api: api, timerInterval: .milliseconds(20), now: { clock.now })
        model.scenePhaseChanged(isActive: true)
        await model.bootstrap()
        try await waitUntil { !api.liveSiteIDs.isEmpty }

        let coordinator = try #require(model.coordinator)
        await model.signOut()
        api.resumeLiveRequests()
        try await Task.sleep(for: .milliseconds(200))

        #expect(coordinator.live.response == nil)
        #expect(coordinator.live.lastSuccess == nil)
    }

    @Test("Sign-out removes the launch snapshot and stops retained coordinator requests")
    func signOutClearsSnapshot() async throws {
        let cacheURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("dashboard.json")
        defer { try? FileManager.default.removeItem(at: cacheURL.deletingLastPathComponent()) }
        let cache = DashboardCache(fileURL: cacheURL)
        let api = ApplicationAPISpy(sites: [Self.site("site-1")])
        let model = PWUsageAppModel(configuration: try Self.makeConfiguration(), api: api,
                                    userDefaults: makeDefaults(), cache: cache)
        model.scenePhaseChanged(isActive: true)
        await model.bootstrap()
        try await waitUntil { model.coordinator?.bill.response != nil }
        let coordinator = try #require(model.coordinator)
        await model.signOut()
        await coordinator.refreshAll(trigger: .userGesture)
        #expect(model.screenState == .signedOut)
        #expect(cache.snapshot.sites.isEmpty)
        #expect(DashboardCache(fileURL: cacheURL).snapshot.live.isEmpty)
        #expect(!coordinator.pollingTimerIsActive)
        #expect(coordinator.live.response == nil)
        #expect(api.liveSiteIDs.count == 1)
    }
}
