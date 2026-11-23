import AuthenticationServices
import CryptoKit
import Foundation
@testable import PWUsage
import PWUsageCore
import Testing

extension MobileAuthServiceTests {
    @Test("Logout also revokes a second exchange still in flight")
    func logoutRevokesQueuedExchange() async throws {
        let api = FakeMobileAuthAPI()
        api.holdExchange = true
        let service = try makeService(api: api)
        let first = Task { try await service.signIn() }
        defer { first.cancel(); api.resumeExchange() }
        try await eventually { self.fakeSession.startCount == 1 }
        let firstState = try #require(Self.pendingState(in: fakeSession.configuredURLs.first))
        fakeSession.complete(url: try Self.callbackURL(code: "first", state: firstState))
        try await eventually { api.exchangeStartedCount == 1 }
        try await service.logout()
        _ = try? await Self.boundedValue(of: first)
        let second = Task { try await service.signIn() }
        defer { second.cancel() }
        try await eventually { self.fakeSession.startCount == 2 }
        let secondState = try #require(Self.pendingState(in: fakeSession.configuredURLs.last))
        fakeSession.complete(url: try Self.callbackURL(code: "second", state: secondState))
        try await eventually { api.exchangeStartedCount == 2 }
        try await service.logout()
        await #expect(throws: MobileAuthService.AuthError.cancelled) {
            try await Self.boundedValue(of: second)
        }
        api.holdExchange = false
        api.resumeExchange()
        try await eventually { api.exchangeCompletedCount == 2 }
        // Both late responses are dropped unstored; only the two logouts touched the jar.
        try await staysTrue { !api.hasSiteAuthCookie && !service.isAuthenticated }
        #expect(api.cookieEvents == ["clear", "clear"])
    }

    @Test("Ending a session cancels its browser and ignores the later callback", arguments: [false, true])
    func endingSessionCancelsBrowser(invalidate: Bool) async throws {
        let service = try makeService(isAuthenticated: true)
        var cancelled = false
        let attempt = Task {
            do {
                try await service.signIn()
            } catch {
                cancelled = (error as? MobileAuthService.AuthError) == .cancelled
            }
        }
        defer { attempt.cancel() }
        try #require(await waitUpTo { fakeSession.startCount == 1 })
        let callback = try #require(fakeSession.takeCompletion())
        if invalidate {
            try await service.invalidateAuthenticatedSession()
        } else {
            try await service.logout()
        }
        #expect(await waitUpTo { cancelled })
        #expect(fakeSession.cancelCount == 1)
        #expect(!service.pendingContinuationForTesting)
        #expect(!service.hasWebSessionForTesting)
        callback(nil, ASWebAuthenticationSessionError(.canceledLogin))
        #expect(!service.isAuthenticated)
        #expect(fakeAPI.exchanges.isEmpty)
    }

    @Test("Ending a session rejects a parked exchange and never stores its late cookie",
          arguments: [false, true], [false, true])
    func endingSessionRejectsLateExchange(invalidate: Bool, exchangeFails: Bool) async throws {
        fakeAPI.holdExchange = true
        let service = try makeService(isAuthenticated: true)
        var attemptSucceeded: Bool?
        let attempt = Task {
            do {
                try await service.signIn()
                attemptSucceeded = true
            } catch {
                attemptSucceeded = false
            }
        }
        defer { attempt.cancel() }
        try #require(await waitUpTo { fakeSession.startCount == 1 })
        let state = try #require(Self.pendingState(in: fakeSession.configuredURLs.first))
        fakeSession.complete(url: try Self.callbackURL(code: "opaque", state: state))
        try #require(await waitUpTo { fakeAPI.exchangeStartedCount == 1 })

        if invalidate {
            try await service.invalidateAuthenticatedSession()
        } else {
            try await service.logout()
        }
        #expect(!service.isAuthenticated)
        #expect(!service.pendingContinuationForTesting)
        #expect(!service.hasWebSessionForTesting)
        #expect(fakeAPI.cookieClearCount == 1)

        // The response arrives anyway, with Set-Cookie on success.
        if exchangeFails { fakeAPI.exchangeError = TestExchangeError.rejected }
        fakeAPI.resumeExchange()
        try #require(await waitUpTo { fakeAPI.exchangeCompletedCount == 1 && attemptSucceeded != nil })
        try await staysTrue { !fakeAPI.hasSiteAuthCookie && !service.isAuthenticated }
        #expect(attemptSucceeded == false)
        #expect(fakeAPI.cookieEvents == ["clear"])
    }

    @Test("Logout clears cookie even when server request fails")
    func logoutClearsCookieEvenWhenServerRequestFails() async throws {
        fakeAPI.logoutError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        let service = try makeService(isAuthenticated: true)

        await #expect(throws: PWUsageAPIError.recoverableServerError(statusCode: 503)) {
            try await service.logout()
        }
        #expect(fakeAPI.logoutCount == 1)
        #expect(fakeAPI.cookieClearCount == 1)
        #expect(!service.isAuthenticated)
        #expect(fakeForecastCleanup.signOutCount == 1)
    }

    @Test("Logout success also clears cookie")
    func logoutSuccessAlsoClearsCookie() async throws {
        let service = try makeService(isAuthenticated: true)
        try await service.logout()
        #expect(fakeAPI.logoutCount == 1)
        #expect(fakeAPI.cookieClearCount == 1)
        #expect(!service.isAuthenticated)
        #expect(fakeForecastCleanup.signOutCount == 1)
    }

    @Test("Logout reports local forecast cleanup failure after clearing authentication")
    func logoutReportsForecastCleanupFailure() async throws {
        fakeForecastCleanup.shouldFail = true
        let service = try makeService(isAuthenticated: true)

        await #expect(throws: MobileAuthService.AuthError.forecastCleanupFailed) {
            try await service.logout()
        }
        #expect(fakeAPI.cookieClearCount == 1)
        #expect(!service.isAuthenticated)
        #expect(fakeForecastCleanup.signOutCount == 1)
    }

    @Test("Restored session marks authenticated only after caller validates cookie")
    func restoredSessionMarksAuthenticatedOnlyAfterCallerValidatesCookie() async throws {
        let service = try makeService()
        #expect(!service.isAuthenticated)

        service.restoreAuthenticatedSession()

        #expect(service.isAuthenticated)
        try await service.invalidateAuthenticatedSession()
        #expect(!service.isAuthenticated)
        #expect(fakeAPI.cookieClearCount == 1)
    }
}
