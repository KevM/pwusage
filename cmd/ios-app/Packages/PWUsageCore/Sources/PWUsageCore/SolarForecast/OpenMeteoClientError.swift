import Foundation

public enum OpenMeteoClientError: Error, Equatable, Sendable {
    case transportFailure
    case invalidResponse
    case decodingFailure
    case rateLimited(retryAfter: Date?)
    case httpStatus(Int)
}
