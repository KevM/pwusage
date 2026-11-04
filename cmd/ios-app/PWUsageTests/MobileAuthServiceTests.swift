import AuthenticationServices
import CryptoKit
import Foundation
@testable import PWUsage
import Testing

@MainActor
@Suite("Mobile Auth Service Tests", .serialized)
final class MobileAuthServiceTests {
    static let attemptID = "9b47b05a-3f0b-498e-b604-9e43fa7df015"
    var fakeAPI = FakeMobileAuthAPI()
    var fakeSession = FakeWebAuthenticationSession()
    var fakeForecastCleanup = FakeSolarForecastSessionCleanup()

    @Test("PKCE material uses base64URL without padding and SHA256 challenge")
    func pkceMaterialUsesBase64URLWithoutPaddingAndSHA256Challenge() throws {
        let material = try MobileAuthService.makePKCEMaterial()

        #expect((43 ... 128).contains(material.verifier.count))
        #expect(material.verifier.allSatisfy(Self.isBase64URLCharacter))
        #expect(!material.verifier.contains("="))
        #expect((43 ... 128).contains(material.challenge.count))
        #expect(material.challenge == Self.base64URL(SHA256.hash(data: Data(material.verifier.utf8))))
        #expect((43 ... 128).contains(material.state.count))
        #expect(material.state.allSatisfy(Self.isBase64URLCharacter))
    }

    @Test("Callback requires exact scheme, host, path and matching state")
    func callbackRequiresExactSchemeHostPathAndMatchingState() throws {
        let valid = try #require(
            URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=expected"))
        let callback = try MobileAuthService.parseCallback(valid, expectedState: "expected")
        #expect(callback.code == "opaque")
        #expect(callback.attemptID == Self.attemptID)

        let wrongScheme = try #require(
            URL(string: "https://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=expected"))
        let wrongHost = try #require(
            URL(string: "pwusage://other/callback?code=opaque&attempt=\(Self.attemptID)&state=expected"))
        let wrongPath = try #require(
            URL(string: "pwusage://auth/other?code=opaque&attempt=\(Self.attemptID)&state=expected"))
        let wrongState = try #require(
            URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=other"))

        #expect(throws: (any Error).self) {
            try MobileAuthService.parseCallback(wrongScheme, expectedState: "expected")
        }
        #expect(throws: (any Error).self) {
            try MobileAuthService.parseCallback(wrongHost, expectedState: "expected")
        }
        #expect(throws: (any Error).self) {
            try MobileAuthService.parseCallback(wrongPath, expectedState: "expected")
        }
        #expect(throws: (any Error).self) {
            try MobileAuthService.parseCallback(wrongState, expectedState: "expected")
        }
    }

    @Test("Callback requires unique code, attempt and state and rejects token parameters")
    func callbackRequiresUniqueCodeAttemptAndStateAndRejectsTokenParameters() throws {
        let missingCode = try #require(
            URL(string: "pwusage://auth/callback?attempt=\(Self.attemptID)&state=expected"))
        let duplicateState = try #require(
            URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=expected&state=expected"))
        let tokenInURL = try #require(
            URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=expected&jwt=secret"))

        #expect(throws: (any Error).self) {
            try MobileAuthService.parseCallback(missingCode, expectedState: "expected")
        }
        #expect(throws: (any Error).self) {
            try MobileAuthService.parseCallback(duplicateState, expectedState: "expected")
        }
        #expect(throws: (any Error).self) {
            try MobileAuthService.parseCallback(tokenInURL, expectedState: "expected")
        }
    }

    @Test("Callback server error and ASWebAuthentication cancellation are distinct")
    func callbackServerErrorAndASWebAuthenticationCancellationAreDistinct() async throws {
        let serverError = try #require(URL(string: "pwusage://auth/callback?error=no_sites&state=expected"))
        #expect(throws: MobileAuthService.AuthError.serverRejectedLogin) {
            try MobileAuthService.parseCallback(serverError, expectedState: "expected")
        }

        let service = try makeService()
        let task = Task { try await service.signIn() }
        try #require(await waitUpTo { fakeSession.startCount == 1 })
        fakeSession.complete(error: ASWebAuthenticationSessionError(.canceledLogin))
        await #expect(throws: MobileAuthService.AuthError.cancelled) {
            try await task.value
        }
        #expect(fakeAPI.exchanges.isEmpty)
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
            .domain: "pwusage.test", .path: "/", .name: "site_auth", .value: "session-secret", .secure: "TRUE"
        ]))
        let preferenceCookie = try #require(HTTPCookie(properties: [
            .domain: "pwusage.test", .path: "/", .name: "display", .value: "compact"
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

    func makeService(
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

    static func callbackURL(code: String, state: String) throws -> URL {
        try #require(URL(string: "pwusage://auth/callback?code=\(code)&attempt=\(attemptID)&state=\(state)"))
    }

    static func pendingState(in sessionURL: URL?) -> String? {
        guard let sessionURL,
              let components = URLComponents(url: sessionURL, resolvingAgainstBaseURL: false) else { return nil }
        return components.queryItems?.first(where: { $0.name == "mobile_state" })?.value
    }

    /// Polls `condition` on the main actor until it holds or a short deadline expires.
    /// Bounded on purpose: these tests must fail with a diagnostic rather than hang when
    /// a leaked sign-in continuation is never resumed.
    func waitUpTo(timeout: Duration = .seconds(5), _ condition: () -> Bool) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if condition() { return true }
            await Task.yield()
        }
        return condition()
    }

    /// Awaits `task` under a deadline. A bare `try await task.value` on a sign-in task is an
    /// unbounded wait: if the continuation is never resumed the suite hangs until the
    /// run-tests deadline instead of failing. Racing it against a sleep makes a leaked
    /// continuation a test failure, and leaves the task handle itself untouched.
    static func boundedValue<Value: Sendable>(
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

    static func isBase64URLCharacter(_ character: Character) -> Bool {
        character.isASCII && (character.isLetter || character.isNumber || character == "-" || character == "_")
    }

    static func base64URL(_ digest: SHA256.Digest) -> String {
        Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

@MainActor
final class FakeSolarForecastSessionCleanup: SolarForecastSessionCleanup {
    private(set) var signOutCount = 0
    var shouldFail = false
    func signOut() async throws {
        signOutCount += 1
        if shouldFail { throw TestCleanupError.failed }
    }
}

private enum TestCleanupError: Error { case failed }
enum TestExchangeError: Error { case rejected }
private enum TestWaitTimeout: Error { case expired }

@MainActor
final class FakeWebAuthenticationSession: MobileAuthWebSession {
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
final class FakeMobileAuthAPI: MobileAuthAPI {
    private(set) var exchanges: [MobileSessionExchange] = []
    var exchangeError: Error?
    var rejectedExchangeCodes: Set<String> = []
    private(set) var logoutCount = 0
    var logoutError: Error?
    private(set) var cookieClearCount = 0
    private(set) var hasSiteAuthCookie = false
    private(set) var siteAuthCookieCode: String?
    var holdCookieClear = false
    private(set) var cookieClearStartedCount = 0
    private var pendingCookieClear: CheckedContinuation<Void, Never>?
    private(set) var cookieEvents: [String] = []
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
        hasSiteAuthCookie = true
        siteAuthCookieCode = exchange.code
        cookieEvents.append("set")
        exchangeCompletedCount += 1
        if let exchangeError { throw exchangeError }
        if rejectedExchangeCodes.contains(exchange.code) { throw TestExchangeError.rejected }
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

    func resumeCookieClear() {
        holdCookieClear = false
        let continuation = pendingCookieClear
        pendingCookieClear = nil
        continuation?.resume()
    }

    func clearSiteAuthCookie() async {
        cookieClearStartedCount += 1
        if holdCookieClear {
            await withCheckedContinuation { pendingCookieClear = $0 }
        }
        cookieClearCount += 1
        hasSiteAuthCookie = false
        siteAuthCookieCode = nil
        cookieEvents.append("clear")
    }
}
