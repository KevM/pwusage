import AuthenticationServices
import CryptoKit
import Foundation
import XCTest
@testable import PWUsage

@MainActor
final class MobileAuthServiceTests: XCTestCase {
    func testPKCEMaterialUsesBase64URLWithoutPaddingAndSHA256Challenge() throws {
        let material = try MobileAuthService.makePKCEMaterial()

        XCTAssertTrue((43...128).contains(material.verifier.count))
        XCTAssertTrue(material.verifier.allSatisfy(Self.isBase64URLCharacter))
        XCTAssertFalse(material.verifier.contains("="))
        XCTAssertTrue((43...128).contains(material.challenge.count))
        XCTAssertEqual(material.challenge, Self.base64URL(SHA256.hash(data: Data(material.verifier.utf8))))
        XCTAssertTrue((43...128).contains(material.state.count))
        XCTAssertTrue(material.state.allSatisfy(Self.isBase64URLCharacter))
    }

    func testCallbackRequiresExactSchemeHostPathAndMatchingState() throws {
        let valid = try XCTUnwrap(URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=expected"))
        let callback = try MobileAuthService.parseCallback(valid, expectedState: "expected")
        XCTAssertEqual(callback.code, "opaque")
        XCTAssertEqual(callback.attemptID, Self.attemptID)

        let wrongScheme = try XCTUnwrap(URL(string: "https://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=expected"))
        let wrongHost = try XCTUnwrap(URL(string: "pwusage://other/callback?code=opaque&attempt=\(Self.attemptID)&state=expected"))
        let wrongPath = try XCTUnwrap(URL(string: "pwusage://auth/other?code=opaque&attempt=\(Self.attemptID)&state=expected"))
        let wrongState = try XCTUnwrap(URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=other"))

        XCTAssertThrowsError(try MobileAuthService.parseCallback(wrongScheme, expectedState: "expected"))
        XCTAssertThrowsError(try MobileAuthService.parseCallback(wrongHost, expectedState: "expected"))
        XCTAssertThrowsError(try MobileAuthService.parseCallback(wrongPath, expectedState: "expected"))
        XCTAssertThrowsError(try MobileAuthService.parseCallback(wrongState, expectedState: "expected"))
    }

    func testCallbackRequiresUniqueCodeAttemptAndStateAndRejectsTokenParameters() throws {
        let missingCode = try XCTUnwrap(URL(string: "pwusage://auth/callback?attempt=\(Self.attemptID)&state=expected"))
        let duplicateState = try XCTUnwrap(URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=expected&state=expected"))
        let tokenInURL = try XCTUnwrap(URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=expected&jwt=secret"))

        XCTAssertThrowsError(try MobileAuthService.parseCallback(missingCode, expectedState: "expected"))
        XCTAssertThrowsError(try MobileAuthService.parseCallback(duplicateState, expectedState: "expected"))
        XCTAssertThrowsError(try MobileAuthService.parseCallback(tokenInURL, expectedState: "expected"))
    }

    func testCallbackServerErrorAndASWebAuthenticationCancellationAreDistinct() async throws {
        let serverError = try XCTUnwrap(URL(string: "pwusage://auth/callback?error=no_sites&state=expected"))
        XCTAssertThrowsError(try MobileAuthService.parseCallback(serverError, expectedState: "expected")) { error in
            XCTAssertEqual(error as? MobileAuthService.AuthError, .serverRejectedLogin)
        }

        let service = makeService()
        let task = Task { try await service.signIn() }
        await Task.yield()
        fakeSession.complete(error: ASWebAuthenticationSessionError(.canceledLogin))
        do {
            try await task.value
            XCTFail("Expected cancellation")
        } catch {
            XCTAssertEqual(error as? MobileAuthService.AuthError, .cancelled)
        }
        XCTAssertTrue(fakeAPI.exchanges.isEmpty)
    }

    func testSignInBuildsExpectedLoginURLAndExchangesOnlyOpaqueCode() async throws {
        let service = makeService()
        let task = Task { try await service.signIn() }
        await Task.yield()

        let loginURL = try XCTUnwrap(fakeSession.url)
        let components = try XCTUnwrap(URLComponents(url: loginURL, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/login")
        let query = Dictionary(uniqueKeysWithValues: try XCTUnwrap(components.queryItems).map { ($0.name, $0.value ?? "") })
        let challenge = try XCTUnwrap(query["mobile_challenge"])
        let state = try XCTUnwrap(query["mobile_state"])
        XCTAssertTrue((43...128).contains(challenge.count))
        XCTAssertEqual(fakeSession.callbackScheme, "pwusage")
        XCTAssertFalse(fakeSession.prefersEphemeralWebBrowserSession)

        fakeSession.complete(url: try XCTUnwrap(URL(string: "pwusage://auth/callback?code=opaque-code&attempt=\(Self.attemptID)&state=\(state)")))
        try await task.value

        XCTAssertTrue(service.isAuthenticated)
        XCTAssertEqual(fakeAPI.exchanges.count, 1)
        XCTAssertEqual(fakeAPI.exchanges.first?.attemptId, Self.attemptID)
        XCTAssertEqual(fakeAPI.exchanges.first?.code, "opaque-code")
        XCTAssertEqual(fakeAPI.exchanges.first?.state, state)
        XCTAssertEqual(fakeAPI.exchanges.first?.verifier.count, 43)
        XCTAssertEqual(Self.base64URL(SHA256.hash(data: Data(fakeAPI.exchanges[0].verifier.utf8))), challenge)
    }

    func testSignInRejectsMalformedCallbackWithoutExchangingSession() async {
        let service = makeService()
        let task = Task { try await service.signIn() }
        await Task.yield()
        fakeSession.complete(url: URL(string: "pwusage://wrong/callback?code=opaque&attempt=\(Self.attemptID)&state=wrong"))

        do {
            try await task.value
            XCTFail("Expected invalid callback")
        } catch {
            XCTAssertEqual(error as? MobileAuthService.AuthError, .invalidCallback)
        }
        XCTAssertTrue(fakeAPI.exchanges.isEmpty)
        XCTAssertFalse(service.isAuthenticated)
    }

    func testSecondSignInIsRejectedUntilTheFirstSessionExchangeFinishes() async throws {
        let service = makeService()
        fakeAPI.holdExchange = true
        let exchangeStarted = expectation(description: "session exchange started")
        fakeAPI.onExchangeStarted = { exchangeStarted.fulfill() }

        let firstSignIn = Task { try await service.signIn() }
        await Task.yield()
        let state = try XCTUnwrap(URLComponents(url: try XCTUnwrap(fakeSession.url), resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "mobile_state" })?.value)
        fakeSession.complete(url: try XCTUnwrap(URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=\(state)")))
        await fulfillment(of: [exchangeStarted], timeout: 2)

        do {
            try await service.signIn()
            XCTFail("Expected the second sign-in attempt to be rejected")
        } catch {
            XCTAssertEqual(error as? MobileAuthService.AuthError, .alreadyInProgress)
        }
        XCTAssertEqual(fakeSession.startCount, 1)
        XCTAssertFalse(service.isAuthenticated)

        fakeAPI.resumeExchange()
        try await firstSignIn.value
        XCTAssertTrue(service.isAuthenticated)
    }

    func testExchangeSignInRequiredLeavesAuthenticationFalse() async {
        fakeAPI.exchangeError = PWUsageAPIError.signInRequired
        let service = makeService()
        let task = Task { try await service.signIn() }
        await Task.yield()
        let state = try! XCTUnwrap(URLComponents(url: try! XCTUnwrap(fakeSession.url), resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "mobile_state" })?.value)
        fakeSession.complete(url: URL(string: "pwusage://auth/callback?code=opaque&attempt=\(Self.attemptID)&state=\(state)"))

        do {
            try await task.value
            XCTFail("Expected sign-in required")
        } catch {
            XCTAssertEqual(error as? PWUsageAPIError, .signInRequired)
        }
        XCTAssertFalse(service.isAuthenticated)
    }

    func testLogoutClearsCookieEvenWhenServerRequestFails() async {
        fakeAPI.logoutError = PWUsageAPIError.recoverableServerError(statusCode: 503)
        let service = makeService(isAuthenticated: true)

        do {
            try await service.logout()
            XCTFail("Expected server error")
        } catch {
            XCTAssertEqual(error as? PWUsageAPIError, .recoverableServerError(statusCode: 503))
        }
        XCTAssertEqual(fakeAPI.logoutCount, 1)
        XCTAssertEqual(fakeAPI.cookieClearCount, 1)
        XCTAssertFalse(service.isAuthenticated)
    }

    func testLogoutSuccessAlsoClearsCookie() async throws {
        let service = makeService(isAuthenticated: true)
        try await service.logout()
        XCTAssertEqual(fakeAPI.logoutCount, 1)
        XCTAssertEqual(fakeAPI.cookieClearCount, 1)
        XCTAssertFalse(service.isAuthenticated)
    }

    func testRestoredSessionMarksAuthenticatedOnlyAfterCallerValidatesCookie() async {
        let service = makeService()
        XCTAssertFalse(service.isAuthenticated)

        service.restoreAuthenticatedSession()

        XCTAssertTrue(service.isAuthenticated)
        await service.invalidateAuthenticatedSession()
        XCTAssertFalse(service.isAuthenticated)
        XCTAssertEqual(fakeAPI.cookieClearCount, 1)
    }

    func testAPIExplicitlyRemovesOnlyTheSiteAuthCookie() async throws {
        let cookieStorage = HTTPCookieStorage.shared
        let cookieSessionConfiguration = URLSessionConfiguration.ephemeral
        cookieSessionConfiguration.httpCookieStorage = cookieStorage
        let session = URLSession(configuration: cookieSessionConfiguration)
        defer {
            session.invalidateAndCancel()
            cookieStorage.cookies(for: URL(string: "https://pwusage.test")!)?.forEach(cookieStorage.deleteCookie)
        }

        let origin = URL(string: "https://pwusage.test")!
        let siteCookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "pwusage.test", .path: "/", .name: "site_auth", .value: "session-secret", .secure: "TRUE",
        ]))
        let preferenceCookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "pwusage.test", .path: "/", .name: "display", .value: "compact",
        ]))
        cookieStorage.setCookie(siteCookie)
        cookieStorage.setCookie(preferenceCookie)
        let api = PWUsageAPI(configuration: try AppConfiguration(apiOrigin: origin), session: session)

        await api.clearSiteAuthCookie()

        let remaining = cookieStorage.cookies(for: origin) ?? []
        XCTAssertFalse(remaining.contains(where: { $0.name == "site_auth" }))
        XCTAssertTrue(remaining.contains(where: { $0.name == "display" }))
    }

    private static let attemptID = "9b47b05a-3f0b-498e-b604-9e43fa7df015"
    private var fakeAPI = FakeMobileAuthAPI()
    private var fakeSession = FakeWebAuthenticationSession()

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
