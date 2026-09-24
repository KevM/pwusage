import AuthenticationServices
import Combine
import CryptoKit
import Foundation
import UIKit

@MainActor
protocol MobileAuthWebSession: AnyObject {
    var prefersEphemeralWebBrowserSession: Bool { get set }
    var presentationContextProvider: (any ASWebAuthenticationPresentationContextProviding)? { get set }
    func start() -> Bool
    func cancel()
}

extension ASWebAuthenticationSession: MobileAuthWebSession {}

@MainActor
final class MobileAuthService: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    struct PKCEMaterial: Equatable {
        let verifier: String
        let challenge: String
        let state: String
    }

    struct Callback: Equatable {
        let code: String
        let attemptID: String
        let state: String
    }

    enum AuthError: Error, Equatable {
        case alreadyInProgress
        case invalidCallback
        case stateMismatch
        case serverRejectedLogin
        case cancelled
        case webAuthenticationFailed
        case sessionCouldNotStart
    }

    typealias SessionCompletion = @MainActor (URL?, Error?) -> Void
    typealias SessionFactory = @MainActor (URL, String, @escaping SessionCompletion) -> any MobileAuthWebSession

    @Published private(set) var isAuthenticated: Bool

    private let configuration: AppConfiguration
    private let api: any MobileAuthAPI
    private let sessionFactory: SessionFactory
    private var webSession: (any MobileAuthWebSession)?
    private var pendingContinuation: CheckedContinuation<Void, Error>?
    private var activeAttempt: PKCEMaterial?

    init(
        configuration: AppConfiguration,
        api: (any MobileAuthAPI)? = nil,
        initialAuthenticationState: Bool = false,
        sessionFactory: @escaping SessionFactory = MobileAuthService.makeSystemWebSession
    ) {
        self.configuration = configuration
        self.api = api ?? PWUsageAPI(configuration: configuration)
        self.isAuthenticated = initialAuthenticationState
        self.sessionFactory = sessionFactory
        super.init()
    }

    static func makePKCEMaterial() throws -> PKCEMaterial {
        let verifier = base64URL(randomBytes(count: 32))
        let challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        let state = base64URL(randomBytes(count: 32))
        guard (43...128).contains(verifier.count), (43...128).contains(state.count) else {
            throw AuthError.webAuthenticationFailed
        }
        return PKCEMaterial(verifier: verifier, challenge: challenge, state: state)
    }

    static func parseCallback(_ url: URL, expectedState: String) throws -> Callback {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "pwusage",
              components.host?.lowercased() == "auth",
              components.path == "/callback",
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.fragment == nil,
              let items = components.queryItems else {
            throw AuthError.invalidCallback
        }

        let allowedNames: Set<String> = ["code", "attempt", "state", "error"]
        guard items.allSatisfy({ allowedNames.contains($0.name) }) else { throw AuthError.invalidCallback }
        var values: [String: String] = [:]
        for item in items {
            guard values[item.name] == nil, let value = item.value, !value.isEmpty else {
                throw AuthError.invalidCallback
            }
            values[item.name] = value
        }

        guard let state = values["state"] else { throw AuthError.invalidCallback }
        guard state == expectedState else { throw AuthError.stateMismatch }
        if values["error"] != nil { throw AuthError.serverRejectedLogin }

        guard let code = values["code"], code.utf8.count <= 512,
              let attemptID = values["attempt"], UUID(uuidString: attemptID) != nil else {
            throw AuthError.invalidCallback
        }
        return Callback(code: code, attemptID: attemptID, state: state)
    }

    func signIn() async throws {
        guard pendingContinuation == nil else { throw AuthError.alreadyInProgress }
        let material = try Self.makePKCEMaterial()
        let loginURL = try makeLoginURL(material: material)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            pendingContinuation = continuation
            activeAttempt = material
            let session = sessionFactory(loginURL, "pwusage") { [weak self] callbackURL, error in
                guard let self else {
                    continuation.resume(throwing: AuthError.webAuthenticationFailed)
                    return
                }
                self.finishAuthentication(callbackURL: callbackURL, error: error)
            }
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = self
            webSession = session
            guard session.start() else {
                webSession = nil
                activeAttempt = nil
                pendingContinuation = nil
                continuation.resume(throwing: AuthError.sessionCouldNotStart)
                return
            }
        }
    }

    func logout() async throws {
        do {
            try await api.logout()
        } catch {
            await api.clearSiteAuthCookie()
            isAuthenticated = false
            throw error
        }
        await api.clearSiteAuthCookie()
        isAuthenticated = false
    }

    /// Restore local signed-in presentation only after an authorized API call
    /// has confirmed that the URLSession's persisted site_auth cookie is valid.
    func restoreAuthenticatedSession() {
        isAuthenticated = true
    }

    /// End the local session after an API request reports that the cookie expired.
    func invalidateAuthenticatedSession() async {
        await api.clearSiteAuthCookie()
        isAuthenticated = false
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }

    private func finishAuthentication(callbackURL: URL?, error: Error?) {
        let continuation = pendingContinuation
        let material = activeAttempt
        webSession = nil
        activeAttempt = nil
        guard let continuation, let material else { return }

        if let error {
            if Self.isUserCancellation(error) {
                completeSignIn(continuation, with: .failure(AuthError.cancelled))
            } else {
                completeSignIn(continuation, with: .failure(AuthError.webAuthenticationFailed))
            }
            return
        }
        guard let callbackURL else {
            completeSignIn(continuation, with: .failure(AuthError.invalidCallback))
            return
        }

        do {
            let callback = try Self.parseCallback(callbackURL, expectedState: material.state)
            let exchange = MobileSessionExchange(
                attemptId: callback.attemptID,
                code: callback.code,
                verifier: material.verifier,
                state: callback.state
            )
            Task { @MainActor in
                do {
                    try await api.exchangeSession(exchange)
                    isAuthenticated = true
                    completeSignIn(continuation, with: .success(()))
                } catch {
                    isAuthenticated = false
                    completeSignIn(continuation, with: .failure(error))
                }
            }
        } catch {
            completeSignIn(continuation, with: .failure(error))
        }
    }

    private func completeSignIn(_ continuation: CheckedContinuation<Void, Error>, with result: Result<Void, Error>) {
        guard pendingContinuation != nil else { return }
        pendingContinuation = nil
        continuation.resume(with: result)
    }

    private func makeLoginURL(material: PKCEMaterial) throws -> URL {
        guard var components = URLComponents(url: configuration.apiOrigin, resolvingAgainstBaseURL: false) else {
            throw AuthError.webAuthenticationFailed
        }
        components.path = "/login"
        components.queryItems = [
            URLQueryItem(name: "mobile_challenge", value: material.challenge),
            URLQueryItem(name: "mobile_state", value: material.state),
        ]
        guard let url = components.url else { throw AuthError.webAuthenticationFailed }
        return url
    }

    private static func makeSystemWebSession(
        url: URL,
        callbackScheme: String,
        completion: @escaping SessionCompletion
    ) -> any MobileAuthWebSession {
        ASWebAuthenticationSession(url: url, callback: .customScheme(callbackScheme)) { callbackURL, error in
            Task { @MainActor in completion(callbackURL, error) }
        }
    }

    private static func isUserCancellation(_ error: Error) -> Bool {
        let nsError = error as NSError
        return nsError.domain == ASWebAuthenticationSessionError.errorDomain
            && nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue
    }

    private static func randomBytes(count: Int) -> Data {
        var generator = SystemRandomNumberGenerator()
        return Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
