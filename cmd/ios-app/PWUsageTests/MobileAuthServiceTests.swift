import AuthenticationServices
import CryptoKit
import Foundation
import Testing
@testable import PWUsage

@MainActor
@Suite("Mobile Auth Service Tests", .serialized)
final class MobileAuthServiceTests {
    private static let attemptID = "9b47b05a-3f0b-498e-b604-9e43fa7df015"
    private var fakeAPI = FakeMobileAuthAPI()
    private var fakeSession = FakeWebAuthenticationSession()
    private var fakeForecastCleanup = FakeSolarForecastSessionCleanup()

    @Test("PKCE material uses base64URL without padding and SHA256 challenge")
    func pkceMaterialUsesBase64URLWithoutPaddingAndSHA256Challenge() throws {
        let material = try MobileAuthService.makePKCEMaterial()

        #expect((43...128).contains(material.verifier.count))
        #expect(material.verifier.allSatisfy(Self.isBase64URLCharacter))
        #expect(!material.verifier.contains("="))
        #expect((43...128).contains(material.challenge.count))
        #expect(material.challenge == Self.base64URL(SHA256.hash(data: Data(material.verifier.utf8))))
        #expect((43...128).contains(material.state.count))
        #expect(material.state.allSatisfy(Self.isBase64URLCharacter))
    }

    @Test("Callback requires exact scheme, host, path and matching state")
    func callbackRequiresExactSchemeHostPathAndMatchingState() throws {
        let valid = try #require(URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=expected"))
        let callback = try MobileAuthService.parseCallback(valid, expectedState: "expected")
        #expect(callback.code == "opaque")
        #expect(callback.attemptID == Self.attemptID)

        let wrongScheme = try #require(URL(string: "https://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=expected"))
        let wrongHost = try #require(URL(string: "pwusage://other/callback?code=opaque&attempt=\(Self.attemptID)&state=expected"))
        let wrongPath = try #require(URL(string: "pwusage://auth/other?code=opaque&attempt=\(Self.attemptID)&state=expected"))
        let wrongState = try #require(URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=other"))

        #expect(throws: (any Error).self) { try MobileAuthService.parseCallback(wrongScheme, expectedState: "expected") }
        #expect(throws: (any Error).self) { try MobileAuthService.parseCallback(wrongHost, expectedState: "expected") }
        #expect(throws: (any Error).self) { try MobileAuthService.parseCallback(wrongPath, expectedState: "expected") }
        #expect(throws: (any Error).self) { try MobileAuthService.parseCallback(wrongState, expectedState: "expected") }
    }

    @Test("Callback requires unique code, attempt and state and rejects token parameters")
    func callbackRequiresUniqueCodeAttemptAndStateAndRejectsTokenParameters() throws {
        let missingCode = try #require(URL(string: "pwusage://auth/callback?attempt=\(Self.attemptID)&state=expected"))
        let duplicateState = try #require(URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=expected&state=expected"))
        let tokenInURL = try #require(URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=expected&jwt=secret"))

        #expect(throws: (any Error).self) { try MobileAuthService.parseCallback(missingCode, expectedState: "expected") }
        #expect(throws: (any Error).self) { try MobileAuthService.parseCallback(duplicateState, expectedState: "expected") }
        #expect(throws: (any Error).self) { try MobileAuthService.parseCallback(tokenInURL, expectedState: "expected") }
    }

    @Test("Callback server error and ASWebAuthentication cancellation are distinct")
    func callbackServerErrorAndASWebAuthenticationCancellationAreDistinct() async throws {
        let serverError = try #require(URL(string: "pwusage://auth/callback?error=no_sites&state=expected"))
        #expect(throws: MobileAuthService.AuthError.serverRejectedLogin) {
            try MobileAuthService.parseCallback(serverError, expectedState: "expected")
        }

        let service = try makeService()
        let task = Task { try await service.signIn() }
        await Task.yield()
        fakeSession.complete(error: ASWebAuthenticationSessionError(.canceledLogin))
        await #expect(throws: MobileAuthService.AuthError.cancelled) {
            try await task.value
        }
        #expect(fakeAPI.exchanges.isEmpty)
    }

    @Test("Sign-in builds expected login URL and exchanges only opaque code")
    func signInBuildsExpectedLoginURLAndExchangesOnlyOpaqueCode() async throws {
        let service = try makeService()
        let task = Task { try await service.signIn() }
        try #require(await waitUpTo { fakeSession.startCount == 1 })

        let loginURL = try #require(fakeSession.configuredURLs.first)
        let components = try #require(URLComponents(url: loginURL, resolvingAgainstBaseURL: false))
        #expect(components.path == "/login")
        let query = Dictionary(uniqueKeysWithValues: try #require(components.queryItems).map { ($0.name, $0.value ?? "") })
        let challenge = try #require(query["mobile_challenge"])
        let state = try #require(query["mobile_state"])
        #expect((43...128).contains(challenge.count))
        #expect(fakeSession.callbackScheme == "pwusage")
        #expect(!fakeSession.prefersEphemeralWebBrowserSession)

        let callback = URL(string: "pwusage://auth/callback?code=opaque-code&attempt=\(Self.attemptID)&state=\(state)")!
        fakeSession.complete(url: callback)
        try await Self.boundedValue(of: task)

        #expect(service.isAuthenticated)
        #expect(fakeAPI.exchanges.count == 1)
        #expect(fakeAPI.exchanges.first?.attemptId == Self.attemptID)
        #expect(fakeAPI.exchanges.first?.code == "opaque-code")
        #expect(fakeAPI.exchanges.first?.state == state)
        #expect(fakeAPI.exchanges.first?.verifier.count == 43)
        #expect(Self.base64URL(SHA256.hash(data: Data(fakeAPI.exchanges[0].verifier.utf8))) == challenge)
    }

    @Test("Sign-in rejects malformed callback without exchanging session")
    func signInRejectsMalformedCallbackWithoutExchangingSession() async throws {
        let service = try makeService()
        let task = Task { try await service.signIn() }
        await Task.yield()
        fakeSession.complete(url: URL(string: "pwusage://wrong/callback?code=opaque&attempt=\(Self.attemptID)&state=wrong"))

        await #expect(throws: MobileAuthService.AuthError.invalidCallback) {
            try await task.value
        }
        #expect(fakeAPI.exchanges.isEmpty)
        #expect(!service.isAuthenticated)
    }

    @Test("Second sign-in is rejected until the first session exchange finishes")
    func secondSignInIsRejectedUntilTheFirstSessionExchangeFinishes() async throws {
        let service = try makeService()
        fakeAPI.holdExchange = true

        let firstSignIn = Task { try await service.signIn() }
        try #require(await waitUpTo { fakeSession.startCount == 1 })
        let state = try #require(Self.pendingState(in: fakeSession.configuredURLs.first))
        fakeSession.complete(url: URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=\(state)")!)

        // Gate on the exchange counter rather than a published continuation: a wait on a
        // continuation that may never be resumed is exactly the unbounded wait this suite
        // must not contain, and the counter is monotonic, so it cannot pass vacuously.
        try #require(await waitUpTo { fakeAPI.exchangeStartedCount == 1 })

        await #expect(throws: MobileAuthService.AuthError.alreadyInProgress) {
            try await service.signIn()
        }
        #expect(fakeSession.startCount == 1)
        #expect(!service.isAuthenticated)

        fakeAPI.resumeExchange()
        try await Self.boundedValue(of: firstSignIn)
        #expect(service.isAuthenticated)
    }

    @Test("Cancelling sign-in resumes once and clears the pending continuation")
    func cancellingSignInResumesOnceAndClearsPending() async throws {
        let service = try makeService()
        let task = Task { try await service.signIn() }
        try #require(await waitUpTo { service.pendingContinuationForTesting })

        task.cancel()

        // Assert the observable state transition first. A leaked continuation is never
        // resumed, so awaiting the cancelled task would hang until the run-tests deadline
        // instead of failing; #require aborts the test the moment the wait expires.
        try #require(await waitUpTo { !service.pendingContinuationForTesting })
        #expect(fakeSession.cancelCount == 1)
        await #expect(throws: MobileAuthService.AuthError.cancelled) {
            try await task.value
        }

        // The second sign-in must be gated on `startCount`, a monotonically increasing
        // counter, and on its *own* configured URL — not on `fakeSession.url`, which still
        // holds the first attempt's URL until this attempt configures the session. A wait on
        // the shared value would pass vacuously, the callback would be built from the first
        // attempt's state, and the second sign-in would never be resumed.
        let second = Task { try await service.signIn() }
        try #require(await waitUpTo { fakeSession.startCount == 2 })
        let state = try #require(Self.pendingState(in: fakeSession.configuredURLs.last))
        fakeSession.complete(url: URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=\(state)")!)
        try #require(await waitUpTo { service.isAuthenticated })
        #expect(!service.pendingContinuationForTesting)
        try await Self.boundedValue(of: second)
    }

    @Test("A superseded attempt's session callback is applied to no one")
    func staleSessionCallbackIsAppliedToNoOne() async throws {
        let service = try makeService()

        // A presents its session, and its completion is captured before the cancellation.
        // The fake never delivers a completion from `cancel()`, matching the real session
        // whose callback crosses back from out of process — so this is the common ordering,
        // not a rare one.
        let first = Task { try await service.signIn() }
        try #require(await waitUpTo { fakeSession.startCount == 1 })
        let staleCompletion = try #require(fakeSession.takeCompletion())

        // A is cancelled: the local cancellation wins, frees the slot, and resumes A.
        first.cancel()
        try #require(await waitUpTo { !service.pendingContinuationForTesting })
        #expect(fakeSession.cancelCount == 1)
        _ = try? await Self.boundedValue(of: first)

        // B claims the slot and presents its own sheet.
        let second = Task { try await service.signIn() }
        try #require(await waitUpTo { fakeSession.startCount == 2 })
        let secondState = try #require(Self.pendingState(in: fakeSession.configuredURLs.last))
        #expect(secondState != Self.pendingState(in: fakeSession.configuredURLs.first))
        #expect(service.pendingContinuationForTesting)

        // A's in-flight completion now lands, carrying A's `.canceledLogin`. It must be
        // dropped whole: resuming B's continuation would fail B's sign-in with a bogus
        // `.cancelled`, and clearing B's `webSession` would make the presented sheet
        // uncancellable while `activeAttempt` would strand B on its next callback.
        staleCompletion(nil, ASWebAuthenticationSessionError(.canceledLogin))

        #expect(service.pendingContinuationForTesting)
        #expect(service.hasWebSessionForTesting)
        #expect(!service.isAuthenticated)
        #expect(fakeAPI.exchanges.isEmpty)
        #expect(fakeSession.cancelCount == 1)

        // B can still finish.
        fakeSession.complete(url: URL(string: "pwusage://auth/callback?code=second&attempt=\(Self.attemptID)&state=\(secondState)")!)
        try #require(await waitUpTo { service.isAuthenticated })
        #expect(!service.pendingContinuationForTesting)
        try await Self.boundedValue(of: second)
        #expect(fakeAPI.exchanges.first?.code == "second")
    }

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
        fakeSession.complete(url: URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=\(state)")!)
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

    @Test("A late failed exchange cannot sign out a newer successful sign-in")
    func lateFailedExchangeCannotSignOutNewerSuccessfulSignIn() async throws {
        let api = FakeMobileAuthAPI()
        api.holdExchange = true
        let service = try makeService(api: api)

        // The first sign-in's exchange is detached from `signIn()`, so cancelling the
        // sign-in does not stop it: it can still report a failure after the user has
        // signed in again.
        let first = Task { try await service.signIn() }
        try #require(await waitUpTo { fakeSession.startCount == 1 })
        let firstState = try #require(Self.pendingState(in: fakeSession.configuredURLs.first))
        fakeSession.complete(url: URL(string: "pwusage://auth/callback?code=first&attempt=\(Self.attemptID)&state=\(firstState)")!)
        try #require(await waitUpTo { api.exchangeStartedCount == 1 })

        first.cancel()
        try #require(await waitUpTo { !service.pendingContinuationForTesting })
        _ = try? await Self.boundedValue(of: first)

        api.holdExchange = false
        let second = Task { try await service.signIn() }
        try #require(await waitUpTo { fakeSession.startCount == 2 })
        let secondState = try #require(Self.pendingState(in: fakeSession.configuredURLs.last))
        fakeSession.complete(url: URL(string: "pwusage://auth/callback?code=second&attempt=\(Self.attemptID)&state=\(secondState)")!)
        try await Self.boundedValue(of: second)
        #expect(service.isAuthenticated)
        let completedBeforeFailure = api.exchangeCompletedCount

        api.exchangeError = TestExchangeError.rejected
        api.resumeExchange()
        try #require(await waitUpTo { api.exchangeCompletedCount > completedBeforeFailure })

        #expect(service.isAuthenticated)
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
        fakeSession.complete(url: URL(string: "pwusage://auth/callback?code=first&attempt=\(Self.attemptID)&state=\(firstState)")!)
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
        fakeSession.complete(url: URL(string: "pwusage://auth/callback?code=second&attempt=\(Self.attemptID)&state=\(secondState)")!)
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
        let state = try #require(URLComponents(url: sessionURL, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "mobile_state" })?.value)
        fakeSession.complete(url: URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=\(state)"))

        await #expect(throws: PWUsageAPIError.signInRequired) {
            try await task.value
        }
        #expect(!service.isAuthenticated)
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

    @Test("API explicitly removes only the site auth cookie")
    func apiExplicitlyRemovesOnlyTheSiteAuthCookie() async throws {
        let cookieSessionConfiguration = URLSessionConfiguration.ephemeral
        let cookieStorage = try #require(cookieSessionConfiguration.httpCookieStorage)
        let session = URLSession(configuration: cookieSessionConfiguration)
        defer {
            session.invalidateAndCancel()
        }

        let origin = URL(string: "https://pwusage.test")!
        let siteCookie = try #require(HTTPCookie(properties: [
            .domain: "pwusage.test", .path: "/", .name: "site_auth", .value: "session-secret", .secure: "TRUE",
        ]))
        let preferenceCookie = try #require(HTTPCookie(properties: [
            .domain: "pwusage.test", .path: "/", .name: "display", .value: "compact",
        ]))
        cookieStorage.setCookie(siteCookie)
        cookieStorage.setCookie(preferenceCookie)
        let api = PWUsageAPI(
            configuration: try AppConfiguration(apiOrigin: origin, allowUnlistedHost: true),
            session: session
        )

        await api.clearSiteAuthCookie()

        let remaining = cookieStorage.cookies(for: origin) ?? []
        #expect(!remaining.contains(where: { $0.name == "site_auth" }))
        #expect(remaining.contains(where: { $0.name == "display" }))
    }

    private func makeService(
        isAuthenticated: Bool = false,
        startResult: Bool = true,
        api: FakeMobileAuthAPI? = nil,
        sessionFactory: MobileAuthService.SessionFactory? = nil
    ) throws -> MobileAuthService {
        // `pwusage.test` is a stub host, so the allowlist opt-out is explicit.
        let apiConfiguration = try AppConfiguration(apiOriginString: "https://pwusage.test", allowUnlistedHost: true)
        fakeSession.startResult = startResult
        fakeSession.completionBeforeStartResult = nil
        return MobileAuthService(
            configuration: apiConfiguration,
            api: api ?? fakeAPI,
            forecastCleanup: fakeForecastCleanup,
            initialAuthenticationState: isAuthenticated,
            sessionFactory: sessionFactory ?? { url, callbackScheme, completion in
                self.fakeSession.configure(url: url, callbackScheme: callbackScheme, completion: completion)
                return self.fakeSession
            }
        )
    }

    private static func pendingState(in sessionURL: URL?) -> String? {
        guard let sessionURL,
              let components = URLComponents(url: sessionURL, resolvingAgainstBaseURL: false) else { return nil }
        return components.queryItems?.first(where: { $0.name == "mobile_state" })?.value
    }

    /// Polls `condition` on the main actor until it holds or a short deadline expires.
    /// Bounded on purpose: these tests must fail with a diagnostic rather than hang when
    /// a leaked sign-in continuation is never resumed.
    private func waitUpTo(timeout: Duration = .seconds(5), _ condition: () -> Bool) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    /// Awaits `task` under a deadline. A bare `try await task.value` on a sign-in task is an
    /// unbounded wait: if the continuation is never resumed the suite hangs until the
    /// run-tests deadline instead of failing. Racing it against a sleep makes a leaked
    /// continuation a test failure, and leaves the task handle itself untouched.
    private static func boundedValue<Value: Sendable>(
        of task: Task<Value, Error>,
        timeout: Duration = .seconds(5)
    ) async throws -> Value {
        try await withThrowingTaskGroup(of: Value.self) { group in
            group.addTask { try await task.value }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw TestWaitTimeout.expired
            }
            defer { group.cancelAll() }
            guard let value = try await group.next() else { throw TestWaitTimeout.expired }
            return value
        }
    }

    private static func isBase64URLCharacter(_ character: Character) -> Bool {
        character.isASCII && (character.isLetter || character.isNumber || character == "-" || character == "_")
    }

    private static func base64URL(_ digest: SHA256.Digest) -> String {
        Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

@MainActor
private final class FakeSolarForecastSessionCleanup: SolarForecastSessionCleanup {
    private(set) var signOutCount = 0
    var shouldFail = false
    func signOut() async throws {
        signOutCount += 1
        if shouldFail { throw TestCleanupError.failed }
    }
}

private enum TestCleanupError: Error { case failed }
private enum TestExchangeError: Error { case rejected }
private enum TestWaitTimeout: Error { case expired }

@MainActor
private final class FakeWebAuthenticationSession: MobileAuthWebSession {
    var prefersEphemeralWebBrowserSession = true
    var presentationContextProvider: (any ASWebAuthenticationPresentationContextProviding)?
    private(set) var url: URL?
    private(set) var callbackScheme: String?
    private(set) var startCount = 0
    private(set) var cancelCount = 0
    /// Every URL a sign-in attempt handed to this session, in order. Reading an attempt's own
    /// entry (rather than the shared `url`, which still holds the previous attempt's value
    /// until the next one configures the session) is the only sound way to tell attempts apart.
    private(set) var configuredURLs: [URL] = []
    var startResult = true
    var completionBeforeStartResult: Error?
    private var completion: ((URL?, Error?) -> Void)?

    func configure(url: URL, callbackScheme: String, completion: @escaping (URL?, Error?) -> Void) {
        self.url = url
        self.callbackScheme = callbackScheme
        self.completion = completion
        self.configuredURLs.append(url)
    }

    func start() -> Bool {
        startCount += 1
        if let completionBeforeStartResult { complete(error: completionBeforeStartResult) }
        return startResult
    }
    func cancel() { cancelCount += 1 }

    func complete(url: URL? = nil, error: Error? = nil) {
        let callback = completion
        completion = nil
        callback?(url, error)
    }

    /// Detaches the currently configured completion so a test can deliver it *later*,
    /// after a newer attempt has claimed the sign-in slot. `cancel()` deliberately does not
    /// deliver a completion — matching the real session, whose callback crosses back from
    /// out of process and can land after the local cancellation — so this is the only way
    /// to reproduce that ordering.
    func takeCompletion() -> ((URL?, Error?) -> Void)? {
        defer { completion = nil }
        return completion
    }
}

@MainActor
private final class FakeMobileAuthAPI: MobileAuthAPI {
    private(set) var exchanges: [MobileSessionExchange] = []
    var exchangeError: Error?
    private(set) var logoutCount = 0
    var logoutError: Error?
    private(set) var cookieClearCount = 0
    var holdExchange = false
    private(set) var exchangeStartedCount = 0
    private(set) var exchangeCompletedCount = 0
    private var pendingExchange: CheckedContinuation<Void, Error>?

    func exchangeSession(_ exchange: MobileSessionExchange) async throws {
        exchanges.append(exchange)
        if holdExchange {
            exchangeStartedCount += 1
            try await withCheckedThrowingContinuation { continuation in
                pendingExchange = continuation
            }
        }
        exchangeCompletedCount += 1
        if let exchangeError { throw exchangeError }
    }

    func resumeExchange() {
        let continuation = pendingExchange
        pendingExchange = nil
        continuation?.resume()
    }

    func logout() async throws {
        logoutCount += 1
        if let logoutError { throw logoutError }
    }

    func clearSiteAuthCookie() async {
        cookieClearCount += 1
    }
}
