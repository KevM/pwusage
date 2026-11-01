import Foundation
import os

/// In-process authority to produce or consume account layout data for one app session.
/// Revocation is synchronous, so app teardown fences queued actor work before any
/// suspension. It is not a credential and is never persisted; a restarted process
/// issues a new session after restoring the matching account scope.
///
/// It also holds the session's current engine token. The synchronization actor changes it
/// only inside its own turns, and the record store reads it synchronously at its write
/// boundary, so engine binding never depends on the order of cross-actor messages.
final class SolarCloudSession: Sendable {
    private struct State {
        var isValid = true
        var engine: SolarCloudEngineToken?
    }

    let accountScopeID: String
    private let state = OSAllocatedUnfairLock(initialState: State())

    init(accountScopeID: String) {
        self.accountScopeID = accountScopeID
    }

    var isValid: Bool { state.withLock { $0.isValid } }
    var hasEngine: Bool { state.withLock { $0.isValid && $0.engine != nil } }

    func revoke() {
        state.withLock { $0 = State(isValid: false, engine: nil) }
    }

    func isCurrent(_ token: SolarCloudEngineToken) -> Bool {
        state.withLock { $0.isValid && $0.engine == token }
    }

    func attach(_ token: SolarCloudEngineToken) {
        state.withLock { if $0.isValid { $0.engine = token } }
    }

    /// Compare-and-clear, so an obsolete attempt cannot detach its replacement.
    func detach(_ token: SolarCloudEngineToken) {
        state.withLock { if $0.engine == token { $0.engine = nil } }
    }
}

/// Every session is issued here so ending one revokes all authority issued before the
/// end began, including a replacement that raced into the teardown window before its
/// cleanup reached the synchronization actor.
final class SolarCloudSessionIssuer: Sendable {
    private let issued = OSAllocatedUnfairLock(initialState: [SolarCloudSession]())

    func issue(accountScopeID: String) -> SolarCloudSession {
        let session = SolarCloudSession(accountScopeID: accountScopeID)
        issued.withLock { sessions in
            sessions.removeAll { !$0.isValid }
            sessions.append(session)
        }
        return session
    }

    func revokeAll() {
        let sessions = issued.withLock { sessions in
            defer { sessions.removeAll() }
            return sessions
        }
        sessions.forEach { $0.revoke() }
    }
}

/// One CloudKit engine/startup attempt within a session.
struct SolarCloudEngineToken: Hashable, Sendable {
    private let id = UUID()
}

enum SolarCloudActivation: Equatable, Sendable {
    case active
    /// The session was revoked, or another live session already owns account data.
    case rejected
    /// The previous session's cleanup failed. Nothing may write until it is retried.
    case cleanupRequired
}
