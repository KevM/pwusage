#if canImport(FoundationEssentials)
    import FoundationEssentials
#else
    import Foundation
#endif

public enum OpenMeteoClientError: Error, Equatable, Sendable {
    case transportFailure
    case invalidResponse
    case decodingFailure
    case rateLimited(retryAfter: Date?)
    case httpStatus(Int)
}
