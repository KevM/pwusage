import Foundation

/// A PWUsage API failure the app can show or act on.
public enum PWUsageAPIError: Error, Equatable, Sendable, LocalizedError {
    case signInRequired
    case recoverableServerError(statusCode: Int)
    case requestRejected(statusCode: Int, message: String?)
    case invalidResponse

    public var errorDescription: String? {
        switch self {
        case .signInRequired:
            "Please sign in again."
        case .recoverableServerError(let statusCode):
            "Server error (\(statusCode)). Please try again."
        case .requestRejected(let statusCode, let message):
            message ?? "Request failed (\(statusCode))."
        case .invalidResponse:
            "Unexpected response from server."
        }
    }
}
