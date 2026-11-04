import AuthenticationServices
import CryptoKit
import Foundation
@testable import PWUsage
import Testing

extension MobileAuthServiceTests {
    @Test("Sign-in builds expected login URL and exchanges only opaque code")
    func signInBuildsExpectedLoginURLAndExchangesOnlyOpaqueCode() async throws {
        let service = try makeService()
        let task = Task { try await service.signIn() }
        try #require(await waitUpTo { fakeSession.startCount == 1 })

        let loginURL = try #require(fakeSession.configuredURLs.first)
        let components = try #require(URLComponents(url: loginURL, resolvingAgainstBaseURL: false))
        #expect(components.path == "/login")
        let query = Dictionary(uniqueKeysWithValues: try #require(components.queryItems).map {
            ($0.name, $0.value ?? "")
        })
        let challenge = try #require(query["mobile_challenge"])
        let state = try #require(query["mobile_state"])
        #expect((43 ... 128).contains(challenge.count))
        #expect(fakeSession.callbackScheme == "pwusage")
        #expect(!fakeSession.prefersEphemeralWebBrowserSession)

        let callback = try Self.callbackURL(code: "opaque-code", state: state)
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
        try #require(await waitUpTo { fakeSession.startCount == 1 })
        fakeSession.complete(
            url: URL(string: "pwusage://wrong/callback?code=opaque&attempt=\(Self.attemptID)&state=wrong"))

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
        fakeSession.complete(url: try Self.callbackURL(code: "opaque", state: state))

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
        fakeSession.complete(url: try Self.callbackURL(code: "opaque", state: state))
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
        fakeSession.complete(url: try Self.callbackURL(code: "second", state: secondState))
        try #require(await waitUpTo { service.isAuthenticated })
        #expect(!service.pendingContinuationForTesting)
        try await Self.boundedValue(of: second)
        #expect(fakeAPI.exchanges.first?.code == "second")
    }
}
