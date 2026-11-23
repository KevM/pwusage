import Foundation

/// A 409 from the preview: nothing can be sent right now. `reason` is the server's stable code.
struct TeslaSyncUnavailability: LocalizedError, Equatable, Sendable {
    let reason: String
    let message: String

    var errorDescription: String? { message }
}
