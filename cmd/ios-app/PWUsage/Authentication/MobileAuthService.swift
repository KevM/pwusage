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
        case forecastCleanupFailed
    }

    typealias SessionCompletion = @MainActor (URL?, Error?) -> Void
    typealias SessionFactory = @MainActor (URL, String, @escaping SessionCompletion) -> any MobileAuthWebSession

    @Published private(set) var isAuthenticated: Bool

    /// Test-only: exposes whether a sign-in continuation is still pending.
    var pendingContinuationForTesting: Bool { pendingSignIn != nil }

    /// Test-only: exposes whether a web session is still held. A superseded attempt's
    /// callback must leave this true, otherwise the presented sheet can no longer be
    /// cancelled and the next callback for it bails out.
    var hasWebSessionForTesting: Bool { webSession != nil }

    private let configuration: AppConfiguration
    private let api: any MobileAuthAPI
    private let forecastCleanup: any SolarForecastSessionCleanup
    private let sessionFactory: SessionFactory
    private var webSession: (any MobileAuthWebSession)?
    /// A sign-in attempt parked on a continuation, tagged with the generation that owns it.
    /// `CheckedContinuation` is a struct, so the generation is the attempt's identity: a
    /// completion may only touch the slot while it is still the owner.
    private struct PendingSignIn {
        let generation: Int
        let continuation: CheckedContinuation<Void, Error>
    }
    private var pendingSignIn: PendingSignIn?
    /// Monotonic sign-in attempt counter. Bumped once per `signIn()` and never reused.
    private var signInGeneration = 0
    private var sessionEpoch = 0
    private var exchangeTask: Task<Void, Never>?
    private var activeAttempt: PKCEMaterial?

    init(
        configuration: AppConfiguration,
        api: (any MobileAuthAPI)? = nil,
        forecastCleanup: any SolarForecastSessionCleanup = SolarForecastStoreSessionCleanup(store: SolarForecastStore.shared),
        initialAuthenticationState: Bool = false,
        sessionFactory: @escaping SessionFactory = MobileAuthService.makeSystemWebSession
    ) {
        self.configuration = configuration
        self.api = api ?? PWUsageAPI(configuration: configuration)
        self.forecastCleanup = forecastCleanup
        self.isAuthenticated = initialAuthenticationState
        self.sessionFactory = sessionFactory
        super.init()
    }

    static func makePKCEMaterial() throws -> PKCEMaterial {
        let verifier = base64URL(randomBytes(count: 32))
        let challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        let state = base64URL(randomBytes(count: 32))
        guard (43 ... 128).contains(verifier.count), (43 ... 128).contains(state.count) else {
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
        guard pendingSignIn == nil else { throw AuthError.alreadyInProgress }
        let material = try Self.makePKCEMaterial()
        let loginURL = try makeLoginURL(material: material)
        signInGeneration += 1
        let generation = signInGeneration

        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: AuthError.cancelled)
                    return
                }
                pendingSignIn = PendingSignIn(generation: generation, continuation: continuation)
                activeAttempt = material
                let session = sessionFactory(loginURL, "pwusage") { [weak self] callbackURL, error in
                    guard let self else {
                        // Bypasses `completeSignIn` on purpose: it is an instance method and
                        // `self` is already deallocated, so there is no pending sign-in
                        // to clear and nothing left that could resume twice.
                        continuation.resume(throwing: AuthError.webAuthenticationFailed)
                        return
                    }
                    // The generation travels *with* the callback. Reading it from the
                    // pending slot here would identify whichever attempt is current, not the
                    // one this session belongs to — and a session's completion can arrive long
                    // after a newer attempt has claimed the slot.
                    self.finishAuthentication(callbackURL: callbackURL, error: error, generation: generation)
                }
                session.prefersEphemeralWebBrowserSession = false
                session.presentationContextProvider = self
                webSession = session
                guard session.start() else {
                    webSession = nil
                    activeAttempt = nil
                    completeSignIn(generation: generation, continuation, with: .failure(AuthError.sessionCouldNotStart))
                    return
                }
            }
        } onCancel: {
            Task { @MainActor in
                // Every side effect is scoped to this attempt. `onCancel` can run long after
                // this attempt's continuation was resumed by its own session callback, so an
                // unguarded `webSession?.cancel()` would cancel the sheet of a newer attempt,
                // and an unguarded `activeAttempt = nil` would make that attempt's real
                // callback bail — stranding its continuation in `.alreadyInProgress` forever.
                guard let pending = pendingSignIn, pending.generation == generation else { return }
                webSession?.cancel()
                webSession = nil
                activeAttempt = nil
                completeSignIn(generation: generation, pending.continuation, with: .failure(AuthError.cancelled))
            }
        }
    }

    func logout() async throws {
        endLocalSession()
        var serverError: Error?
        do { try await api.logout() } catch { serverError = error }
        await api.clearSiteAuthCookie()
        isAuthenticated = false
        do { try await forecastCleanup.signOut() } catch { throw AuthError.forecastCleanupFailed }
        if let serverError { throw serverError }
    }

    /// Restore local signed-in presentation only after an authorized API call
    /// has confirmed that the URLSession's persisted site_auth cookie is valid.
    func restoreAuthenticatedSession() {
        isAuthenticated = true
    }

    /// End the local session after an API request reports that the cookie expired.
    func invalidateAuthenticatedSession() async throws {
        endLocalSession()
        await api.clearSiteAuthCookie()
        isAuthenticated = false
        do { try await forecastCleanup.signOut() } catch { throw AuthError.forecastCleanupFailed }
    }

    /// Revoke ownership before any suspension or web-session cancellation callback.
    private func endLocalSession() {
        sessionEpoch += 1
        exchangeTask?.cancel()
        // Keep the tail: a cancelled request can still persist Set-Cookie. A new
        // exchange must wait for its response AND its stale-cookie cleanup.
        let pending = pendingSignIn
        pendingSignIn = nil
        activeAttempt = nil
        let session = webSession
        webSession = nil
        isAuthenticated = false
        pending?.continuation.resume(throwing: AuthError.cancelled)
        session?.cancel()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow) ?? ASPresentationAnchor()
    }

    private func finishAuthentication(callbackURL: URL?, error: Error?, generation: Int) {
        // `generation` is the attempt this session was started for, not "the current
        // attempt". A completion belonging to a superseded attempt is dropped whole: it
        // must not clear the newer attempt's `webSession`/`activeAttempt`, and it must not
        // apply its own result to the newer attempt's continuation.
        guard let pending = pendingSignIn, pending.generation == generation else { return }
        guard let material = activeAttempt else {
            // Unreachable while the slot and the material are cleared together, but resuming
            // is strictly safer than returning: a silent return here would leak `pending`.
            completeSignIn(generation: generation, pending.continuation, with: .failure(AuthError.webAuthenticationFailed))
            return
        }
        webSession = nil
        activeAttempt = nil
        let continuation = pending.continuation

        if let error {
            if Self.isUserCancellation(error) {
                completeSignIn(generation: generation, continuation, with: .failure(AuthError.cancelled))
            } else {
                completeSignIn(generation: generation, continuation, with: .failure(AuthError.webAuthenticationFailed))
            }
            return
        }
        guard let callbackURL else {
            completeSignIn(generation: generation, continuation, with: .failure(AuthError.invalidCallback))
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
            let epoch = sessionEpoch
            let previousExchange = exchangeTask
            exchangeTask = Task { @MainActor in
                await previousExchange?.value
                // Cancellation/logout may have happened while waiting in the queue.
                guard sessionEpoch == epoch,
                      pendingSignIn?.generation == generation,
                      !Task.isCancelled else { return }
                do {
                    try await api.exchangeSession(exchange)
                    guard sessionEpoch == epoch else {
                        // URLSession may already have persisted Set-Cookie, even when
                        // cancellation was requested. Revoke that late credential too.
                        await api.clearSiteAuthCookie()
                        return
                    }
                    if pendingSignIn?.generation == generation { exchangeTask = nil }
                    if completeSignIn(generation: generation, continuation, with: .success(())) {
                        isAuthenticated = true
                    }
                } catch {
                    guard sessionEpoch == epoch else {
                        await api.clearSiteAuthCookie()
                        return
                    }
                    if pendingSignIn?.generation == generation { exchangeTask = nil }
                    if completeSignIn(generation: generation, continuation, with: .failure(error)) {
                        isAuthenticated = false
                    }
                }
            }
        } catch {
            completeSignIn(generation: generation, continuation, with: .failure(error))
        }
    }

    /// Resume `continuation` exactly once, and only while `generation` still owns the pending
    /// slot. A completion belonging to a superseded attempt finds a newer generation in the
    /// slot and is dropped: it must neither resume its own (already resumed) continuation,
    /// which traps, nor clear the slot, which would strand the newer attempt. Returns
    /// whether this call performed the resume, so callers can guard their side effects.
    @discardableResult
    private func completeSignIn(
        generation: Int,
        _ continuation: CheckedContinuation<Void, Error>,
        with result: Result<Void, Error>
    ) -> Bool {
        guard let pending = pendingSignIn, pending.generation == generation else { return false }
        pendingSignIn = nil
        continuation.resume(with: result)
        return true
    }

    private func makeLoginURL(material: PKCEMaterial) throws -> URL {
        guard var components = URLComponents(url: configuration.apiOrigin, resolvingAgainstBaseURL: false) else {
            throw AuthError.webAuthenticationFailed
        }
        components.path = "/login"
        components.queryItems = [
            URLQueryItem(name: "mobile_challenge", value: material.challenge),
            URLQueryItem(name: "mobile_state", value: material.state)
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
        return Data((0 ..< count).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
