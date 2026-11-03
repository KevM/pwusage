import SwiftUI

/// An owner-stable action so dashboard updates do not repeatedly invalidate sheets.
struct TeslaReconnectAction: Equatable {
    private let ownerID: ObjectIdentifier
    let perform: @MainActor () async -> Void

    init<Owner: AnyObject>(owner: Owner, perform: @escaping @MainActor () async -> Void) {
        ownerID = ObjectIdentifier(owner)
        self.perform = perform
    }

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.ownerID == rhs.ownerID }
}

extension EnvironmentValues {
    /// Reuses the app's authenticated Tesla login flow without giving sheets token access.
    @Entry var reconnectTesla: TeslaReconnectAction?
}
