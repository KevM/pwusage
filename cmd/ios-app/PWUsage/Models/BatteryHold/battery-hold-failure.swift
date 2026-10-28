import Foundation

enum BatteryHoldFailure: Equatable {
    case reserveSyncPending, needsReauthentication, needsChoice, noStateOfCharge, noActiveHold, unavailable

    var message: String {
        switch self {
        case .reserveSyncPending: "Tesla is still reporting the reserve from the last Battery Saver. Wait a moment, then try starting again."
        case .needsReauthentication: "Battery control needs Tesla’s Energy Product Commands permission. Reconnect your Tesla account to grant access."
        case .needsChoice: "The battery charge changed. Choose an 80% or 100% reserve, then confirm again."
        case .noStateOfCharge: "Tesla did not return a battery charge reading. Refresh battery data and try again."
        case .noActiveHold: "Battery Saver is already off. Refresh to see the current battery status."
        case .unavailable: "Battery Saver status could not be confirmed. Check your connection and refresh before trying again."
        }
    }
}
