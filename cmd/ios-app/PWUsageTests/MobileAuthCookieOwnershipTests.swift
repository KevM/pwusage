import Foundation
@testable import PWUsage
import Testing

/// The sign-in that owns the attempt decides what reaches the shared cookie jar. Each test
/// reads the jar itself (`siteAuthCookieCode`): the widget and the app's next launch send
/// whatever it holds, whatever `isAuthenticated` says now.
extension MobileAuthServiceTests {
    @Test("A sign-in cancelled during its exchange never stores the late session cookie")
    func cancelledSignInNeverStoresLateCookie() async throws {
        let api = FakeMobileAuthAPI()
        api.holdExchange = true
        let service = try makeService(api: api)
        let attempt = Task { try await service.signIn() }
        defer { attempt.cancel(); api.resumeExchange() }
        try await reachExchange(code: "late", api: api, attempt: 1)

        attempt.cancel()
        await #expect(throws: MobileAuthService.AuthError.cancelled) {
            try await Self.boundedValue(of: attempt)
        }
        // The server answers with Set-Cookie after the user cancelled.
        api.resumeExchange()
        try await eventually { api.exchangeCompletedCount == 1 }
        try await staysTrue { !api.hasSiteAuthCookie && !service.isAuthenticated }
        #expect(api.cookieEvents.isEmpty)
    }

    @Test("A cancelled reconnect keeps the session the app already had")
    func cancelledReconnectKeepsExistingSession() async throws {
        let api = FakeMobileAuthAPI()
        api.seedSiteAuthCookie("existing")
        api.holdExchange = true
        let service = try makeService(isAuthenticated: true, api: api)
        let reconnect = Task { try await service.signIn() }
        defer { reconnect.cancel(); api.resumeExchange() }
        try await reachExchange(code: "reconnect", api: api, attempt: 1)

        reconnect.cancel()
        _ = try? await Self.boundedValue(of: reconnect)
        api.resumeExchange()
        try await eventually { api.exchangeCompletedCount == 1 }
        // Neither replaced by the abandoned attempt's cookie nor cleared on its behalf.
        try await staysTrue { api.siteAuthCookieCode == "existing" && service.isAuthenticated }
        #expect(api.cookieClearCount == 0)
    }

    @Test("Late work from a signed-out attempt cannot erase a newer sign-in",
          arguments: [false, true], [false, true])
    func lateWorkCannotEraseNewerSignIn(invalidate: Bool, lateExchangeFails: Bool) async throws {
        let api = FakeMobileAuthAPI()
        api.holdExchange = true
        if lateExchangeFails { api.rejectedExchangeCodes = ["first"] }
        let service = try makeService(api: api)
        let first = Task { try await service.signIn() }
        defer { first.cancel(); api.resumeExchange() }
        try await reachExchange(code: "first", api: api, attempt: 1)
        if invalidate {
            try await service.invalidateAuthenticatedSession()
        } else {
            try await service.logout()
        }
        _ = try? await Self.boundedValue(of: first)

        // A newer sign-in completes while the first exchange is still outstanding.
        api.holdExchange = false
        let second = Task { try await service.signIn() }
        defer { second.cancel() }
        try await eventually { self.fakeSession.startCount == 2 }
        let secondState = try #require(Self.pendingState(in: fakeSession.configuredURLs.last))
        fakeSession.complete(url: try Self.callbackURL(code: "second", state: secondState))
        try await Self.boundedValue(of: second)
        #expect(api.siteAuthCookieCode == "second")

        // The first attempt's response finally lands, with or without a cookie.
        api.resumeExchange()
        try await eventually { api.exchangeCompletedCount == 2 }
        try await staysTrue { api.siteAuthCookieCode == "second" && service.isAuthenticated }
        #expect(api.cookieEvents == ["clear", "set"])
    }

    /// Start a sign-in's browser step and deliver its callback, leaving the exchange held.
    private func reachExchange(code: String, api: FakeMobileAuthAPI, attempt: Int) async throws {
        try await eventually { self.fakeSession.startCount == attempt }
        let state = try #require(Self.pendingState(in: fakeSession.configuredURLs.last))
        fakeSession.complete(url: try Self.callbackURL(code: code, state: state))
        try await eventually { api.exchangeStartedCount == attempt }
    }
}
