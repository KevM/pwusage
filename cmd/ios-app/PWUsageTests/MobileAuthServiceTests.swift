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

        let service = makeService()
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
        let service = makeService()
        let task = Task { try await service.signIn() }
        await Task.yield()

        let loginURL = try #require(fakeSession.url)
        let components = try #require(URLComponents(url: loginURL, resolvingAgainstBaseURL: false))
        #expect(components.path == "/login")
        let query = Dictionary(uniqueKeysWithValues: try #require(components.queryItems).map { ($0.name, $0.value ?? "") })
        let challenge = try #require(query["mobile_challenge"])
        let state = try #require(query["mobile_state"])
        #expect((43...128).contains(challenge.count))
        #expect(fakeSession.callbackScheme == "pwusage")
        #expect(!fakeSession.prefersEphemeralWebBrowserSession)

        fakeSession.complete(url: try #require(URL(string: "pwusage://auth/callback?code=opaque-code&attempt=\(Self.attemptID)&state=\(state)")))
        try await task.value

        #expect(service.isAuthenticated)
        #expect(fakeAPI.exchanges.count == 1)
        #expect(fakeAPI.exchanges.first?.attemptId == Self.attemptID)
        #expect(fakeAPI.exchanges.first?.code == "opaque-code")
        #expect(fakeAPI.exchanges.first?.state == state)
        #expect(fakeAPI.exchanges.first?.verifier.count == 43)
        #expect(Self.base64URL(SHA256.hash(data: Data(fakeAPI.exchanges[0].verifier.utf8))) == challenge)
    }

    @Test("Sign-in rejects malformed callback without exchanging session")
    func signInRejectsMalformedCallbackWithoutExchangingSession() async {
        let service = makeService()
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
        let service = makeService()
        fakeAPI.holdExchange = true
        var exchangeContinuation: CheckedContinuation<Void, Never>?
        fakeAPI.onExchangeStarted = { exchangeContinuation?.resume() }

        let firstSignIn = Task { try await service.signIn() }
        await Task.yield()
        let sessionURL = try #require(fakeSession.url)
        let state = try #require(URLComponents(url: sessionURL, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "mobile_state" })?.value)

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            exchangeContinuation = continuation
            fakeSession.complete(url: URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=\(state)"))
        }

        await #expect(throws: MobileAuthService.AuthError.alreadyInProgress) {
            try await service.signIn()
        }
        #expect(fakeSession.startCount == 1)
        #expect(!service.isAuthenticated)

        fakeAPI.resumeExchange()
        try await firstSignIn.value
        #expect(service.isAuthenticated)
    }

    @Test("Exchange sign-in required leaves authentication false")
    func exchangeSignInRequiredLeavesAuthenticationFalse() async throws {
        fakeAPI.exchangeError = PWUsageAPIError.signInRequired
        let service = makeService()
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
    func logoutClearsCookieEvenWhenServerRequestFails() async {
        fakeAPI.logoutError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        let service = makeService(isAuthenticated: true)

        await #expect(throws: PWUsageAPIError.recoverableServerError(statusCode: 503)) {
            try await service.logout()
        }
        #expect(fakeAPI.logoutCount == 1)
        #expect(fakeAPI.cookieClearCount == 1)
        #expect(!service.isAuthenticated)
    }

    @Test("Logout success also clears cookie")
    func logoutSuccessAlsoClearsCookie() async throws {
        let service = makeService(isAuthenticated: true)
        try await service.logout()
        #expect(fakeAPI.logoutCount == 1)
        #expect(fakeAPI.cookieClearCount == 1)
        #expect(!service.isAuthenticated)
    }

    @Test("Restored session marks authenticated only after caller validates cookie")
    func restoredSessionMarksAuthenticatedOnlyAfterCallerValidatesCookie() async {
        let service = makeService()
        #expect(!service.isAuthenticated)

        service.restoreAuthenticatedSession()

        #expect(service.isAuthenticated)
        await service.invalidateAuthenticatedSession()
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
        let api = PWUsageAPI(configuration: try AppConfiguration(apiOrigin: origin), session: session)

        await api.clearSiteAuthCookie()

        let remaining = cookieStorage.cookies(for: origin) ?? []
        #expect(!remaining.contains(where: { $0.name == "site_auth" }))
        #expect(remaining.contains(where: { $0.name == "display" }))
    }

    private func makeService(isAuthenticated: Bool = false) -> MobileAuthService {
        let apiConfiguration = try! AppConfiguration(apiOriginString: "https://pwusage.test")
        return MobileAuthService(
            configuration: apiConfiguration,
            api: fakeAPI,
            initialAuthenticationState: isAuthenticated,
            sessionFactory: { url, callbackScheme, completion in
                self.fakeSession.configure(url: url, callbackScheme: callbackScheme, completion: completion)
                return self.fakeSession
            }
        )
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
private final class FakeWebAuthenticationSession: MobileAuthWebSession {
    var prefersEphemeralWebBrowserSession = true
    var presentationContextProvider: (any ASWebAuthenticationPresentationContextProviding)?
    private(set) var url: URL?
    private(set) var callbackScheme: String?
    private(set) var startCount = 0
    private var startResults = [true, false]
    private var completion: ((URL?, Error?) -> Void)?

    func configure(url: URL, callbackScheme: String, completion: @escaping (URL?, Error?) -> Void) {
        self.url = url
        self.callbackScheme = callbackScheme
        self.completion = completion
    }

    func start() -> Bool {
        startCount += 1
        return startResults.isEmpty ? true : startResults.removeFirst()
    }
    func cancel() {}

    func complete(url: URL? = nil, error: Error? = nil) {
        let callback = completion
        completion = nil
        callback?(url, error)
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
    var onExchangeStarted: (() -> Void)?
    private var pendingExchange: CheckedContinuation<Void, Error>?

    func exchangeSession(_ exchange: MobileSessionExchange) async throws {
        exchanges.append(exchange)
        if holdExchange {
            try await withCheckedThrowingContinuation { continuation in
                pendingExchange = continuation
                onExchangeStarted?()
            }
        }
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
