import Foundation

enum SolarForecastSettingsOperation: Equatable {
    case connection
    case discovery
    case selection
    case disconnect
}

struct SolarForecastSettingsPresentation: Equatable {
    let message: String
    let isConnected: Bool
    let allowsManualIDs: Bool
}

enum SolarForecastSettingsStatus {
    static func presentation(
        for error: Error,
        operation: SolarForecastSettingsOperation,
        hasCredential: Bool
    ) -> SolarForecastSettingsPresentation {
        guard let storeError = error as? SolarForecastStore.StoreError else {
            return providerFailure(hasCredential: hasCredential, operation: operation)
        }

        switch storeError {
        case .discoveryFailed(.unauthorized):
            return SolarForecastSettingsPresentation(
                message: "Solcast rejected this API key. Check or replace it.",
                isConnected: false,
                allowsManualIDs: false
            )
        case .discoveryFailed(.rateLimited), .deferred:
            return SolarForecastSettingsPresentation(
                message: "Solcast is limiting requests right now. Your key is saved; try again later.",
                isConnected: hasCredential,
                allowsManualIDs: false
            )
        case .budgetExhausted:
            return SolarForecastSettingsPresentation(
                message: "This device has used its Solcast request allowance for today. Try again tomorrow.",
                isConnected: hasCredential,
                allowsManualIDs: false
            )
        case .discoveryFailed(.requestFailed), .discoveryFailed(.invalidForecast), .requestFailed:
            return providerFailure(hasCredential: hasCredential, operation: operation)
        case .cleanupFailed where operation == .disconnect:
            return SolarForecastSettingsPresentation(
                message: "Disconnect could not finish safely. Your connection is still present; please retry.",
                isConnected: hasCredential,
                allowsManualIDs: false
            )
        case .persistenceFailed where operation == .connection:
            return SolarForecastSettingsPresentation(
                message: "This device could not safely save the Solcast connection. Please try again.",
                isConnected: hasCredential,
                allowsManualIDs: false
            )
        case .persistenceFailed, .cleanupFailed,
             .discoveryFailed(.storageFailure), .discoveryFailed(.cleanupFailure):
            return SolarForecastSettingsPresentation(
                message: "This device could not safely save the change. Please try again.",
                isConnected: hasCredential,
                allowsManualIDs: false
            )
        case .invalidConfiguration:
            return SolarForecastSettingsPresentation(
                message: "Check the key or Solar System IDs and try again.",
                isConnected: hasCredential,
                allowsManualIDs: false
            )
        case .notConfigured:
            return SolarForecastSettingsPresentation(
                message: "Save a valid Solcast key before choosing arrays.",
                isConnected: false,
                allowsManualIDs: false
            )
        case .cancelled:
            return SolarForecastSettingsPresentation(
                message: "That change was superseded. Check the current settings and try again if needed.",
                isConnected: hasCredential,
                allowsManualIDs: false
            )
        }
    }

    private static func providerFailure(
        hasCredential: Bool,
        operation: SolarForecastSettingsOperation
    ) -> SolarForecastSettingsPresentation {
        SolarForecastSettingsPresentation(
            message: operation == .discovery
                ? "Solcast could not be reached. You can enter Solar System IDs manually or retry discovery."
                : "Solcast could not be reached. Check your connection and try again.",
            isConnected: hasCredential,
            allowsManualIDs: operation == .discovery && hasCredential
        )
    }
}
