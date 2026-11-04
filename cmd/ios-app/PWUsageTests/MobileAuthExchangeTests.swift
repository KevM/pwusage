import AuthenticationServices
import CryptoKit
import Foundation
@testable import PWUsage
import Testing

extension MobileAuthServiceTests {
    @Test("A session that reports start failure after delivering a result does not resume twice")
    func failedStartAfterResultDoesNotResumeTwice() async throws {
        let service = try makeService(startResult: false)
        fakeSession.completionBeforeStartResult = ASWebAuthenticationSessionError(.canceledLogin)

        // The completion wins the race, so it supplies the resume value. The start-failure
        // branch must then be a no-op: resuming again traps as a continuation misuse.
        await #expect(throws: MobileAuthService.AuthError.cancelled) {
            try await service.signIn()
        }
        #expect(!service.pendingContinuationForTesting)
    }

    @Test("Cancelling during a stalled token exchange does not authenticate")
    func cancellingDuringStalledExchangeDoesNotAuthenticate() async throws {
        let api = FakeMobileAuthAPI()
        api.holdExchange = true
        let service = try makeService(api: api)

        let task = Task { try await service.signIn() }
        try #require(await waitUpTo { fakeSession.startCount == 1 })
        let state = try #require(Self.pendingState(in: fakeSession.configuredURLs.first))
        fakeSession.complete(url: try Self.callbackURL(code: "opaque", state: state))
        try #require(await waitUpTo { api.exchangeStartedCount == 1 })

        task.cancel()
        try #require(await waitUpTo { !service.pendingContinuationForTesting })

        // The stalled exchange belongs to a detached task, so it keeps running after the
        // sign-in is cancelled; it must not be allowed to authenticate. Note that the
        // regression this guards against fails as an intentional process-level trap
        // (a continuation double-resume traps, it is not an observable error), so a
        // crashed test binary here is expected on a regression, not a broken harness.
        api.resumeExchange()
        try #require(await waitUpTo { api.exchangeCompletedCount == 1 })
        #expect(!service.isAuthenticated)
    }

    @Test("A newer sign-in waits for a superseded failed exchange before succeeding")
    func newerSignInWaitsForSupersededFailedExchange() async throws {
        let api = FakeMobileAuthAPI()
        api.holdExchange = true
        api.rejectedExchangeCodes = ["first"]
        let service = try makeService(api: api)
        let first = Task { try await service.signIn() }
        defer { first.cancel(); api.resumeExchange() }
        try await eventually { self.fakeSession.startCount == 1 }
        let firstState = try #require(Self.pendingState(in: fakeSession.configuredURLs.first))
        fakeSession.complete(url: try Self.callbackURL(code: "first", state: firstState))
        try await eventually { api.exchangeStartedCount == 1 }
        first.cancel()
        try await eventually { !service.pendingContinuationForTesting }
        _ = try? await Self.boundedValue(of: first)

        api.holdExchange = false
        let second = Task { try await service.signIn() }
        defer { second.cancel() }
        try await eventually { self.fakeSession.startCount == 2 }
        let secondState = try #require(Self.pendingState(in: fakeSession.configuredURLs.last))
        fakeSession.complete(url: try Self.callbackURL(code: "second", state: secondState))
        try await staysTrue { api.exchanges.count == 1 && !service.isAuthenticated }
        api.resumeExchange()
        try await eventually { api.exchangeCompletedCount == 2 && service.isAuthenticated }
        try await Self.boundedValue(of: second)
        #expect(api.siteAuthCookieCode == "second")
    }

    @Test("A late failed exchange cannot disturb a newer pending sign-in")
    func lateFailedExchangeCannotDisturbNewerPendingSignIn() async throws {
        let api = FakeMobileAuthAPI()
        api.holdExchange = true
        let service = try makeService(api: api)

        // Sign-in A reaches its token exchange and stalls there.
        let first = Task { try await service.signIn() }
        try #require(await waitUpTo { fakeSession.startCount == 1 })
        let firstState = try #require(Self.pendingState(in: fakeSession.configuredURLs.first))
        fakeSession.complete(url: try Self.callbackURL(code: "first", state: firstState))
        try #require(await waitUpTo { api.exchangeStartedCount == 1 })

        // A is cancelled, which resumes A's continuation and frees the slot.
        first.cancel()
        try #require(await waitUpTo { !service.pendingContinuationForTesting })
        _ = try? await Self.boundedValue(of: first)

        // Sign-in B claims the slot. Gate on B's *own* configured URL, never on the shared
        // `fakeSession.url`: until B configures the session it still holds A's URL, so a wait
        // on it would pass vacuously and the callback would be built from A's state.
        let second = Task { try await service.signIn() }
        try #require(await waitUpTo { fakeSession.startCount == 2 })
        let secondState = try #require(Self.pendingState(in: fakeSession.configuredURLs.last))
        #expect(secondState != firstState)

        // A's detached exchange now fails. It must not resume its own already-resumed
        // continuation (a process-level trap on a regression) and must not discard B's
        // continuation, which would leave the user permanently unable to sign in.
        api.exchangeError = TestExchangeError.rejected
        api.resumeExchange()
        try #require(await waitUpTo { api.exchangeCompletedCount == 1 })
        #expect(!service.isAuthenticated)

        // B can still finish.
        api.holdExchange = false
        api.exchangeError = nil
        fakeSession.complete(url: try Self.callbackURL(code: "second", state: secondState))
        try #require(await waitUpTo { service.isAuthenticated })
        #expect(!service.pendingContinuationForTesting)
        _ = try? await Self.boundedValue(of: second)
    }

    @Test("Exchange sign-in required leaves authentication false")
    func exchangeSignInRequiredLeavesAuthenticationFalse() async throws {
        fakeAPI.exchangeError = PWUsageAPIError.signInRequired
        let service = try makeService()
        let task = Task { try await service.signIn() }
        await Task.yield()
        let sessionURL = try #require(fakeSession.url)
        let components = URLComponents(url: sessionURL, resolvingAgainstBaseURL: false)
        let state = try #require(components?.queryItems?.first(where: { $0.name == "mobile_state" })?.value)
        fakeSession.complete(
            url: URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=\(state)"))

        await #expect(throws: PWUsageAPIError.signInRequired) {
            try await task.value
        }
        #expect(!service.isAuthenticated)
    }

    @Test("A new exchange waits for the old session response and its cookie cleanup",
          arguments: [false, true], [false, true])
    func newerExchangeWaitsForStaleCookieCleanup(invalidate: Bool, exchangeFails: Bool) async throws {
        let api = FakeMobileAuthAPI()
        api.holdExchange = true
        if exchangeFails { api.rejectedExchangeCodes = ["first"] }
        let service = try makeService(api: api)
        var firstCancelled = false
        let first = Task {
            do {
                try await service.signIn()
            } catch {
                firstCancelled = (error as? MobileAuthService.AuthError) == .cancelled
            }
        }
        defer { first.cancel(); api.resumeExchange(); api.resumeCookieClear() }
        try await eventually { self.fakeSession.startCount == 1 }
        let firstState = try #require(Self.pendingState(in: fakeSession.configuredURLs.first))
        fakeSession.complete(url: try Self.callbackURL(code: "first", state: firstState))
        try await eventually { api.exchangeStartedCount == 1 }
        if invalidate {
            try await service.invalidateAuthenticatedSession()
        } else {
            try await service.logout()
        }
        try await eventually { firstCancelled }

        api.holdExchange = false
        api.holdCookieClear = true
        let second = Task { try await service.signIn() }
        defer { second.cancel() }
        try await eventually { self.fakeSession.startCount == 2 }
        let secondState = try #require(Self.pendingState(in: fakeSession.configuredURLs.last))
        fakeSession.complete(url: try Self.callbackURL(code: "second", state: secondState))
        // Even a cancellation-ignoring response must finish before the next exchange.
        try await staysTrue { api.exchanges.count == 1 && !service.isAuthenticated }
        api.resumeExchange()
        try await eventually { api.cookieClearStartedCount == 2 }
        #expect(api.siteAuthCookieCode == "first")
        // Waiting just for the response is insufficient: cleanup can also suspend.
        try await staysTrue { api.exchanges.count == 1 && !service.isAuthenticated }
        api.resumeCookieClear()
        try await eventually { service.isAuthenticated && api.exchangeCompletedCount == 2 }
        try await Self.boundedValue(of: second)
        #expect(api.siteAuthCookieCode == "second")
        #expect(api.cookieEvents == ["clear", "set", "clear", "set"])
    }
}
