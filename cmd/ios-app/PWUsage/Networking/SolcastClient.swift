import Foundation

protocol SolcastTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

private struct URLSessionSolcastTransport: SolcastTransport {
    private let session: URLSession

    init(timeout: TimeInterval) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        session = URLSession(configuration: configuration, delegate: RedirectRejectingDelegate(), delegateQueue: nil)
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await session.data(for: request)
    }
}

private final class RedirectRejectingDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

enum SolcastClientError: Error, Equatable {
    case invalidResourceID
    case transportFailure
    case invalidResponse
    case httpStatus(statusCode: Int, retryAfter: SolcastRetryAfter?)
    case decodingFailure
}

enum SolcastRetryAfter: Equatable, Sendable {
    case delay(seconds: TimeInterval)
    case date(Date)
}

struct SolcastClient: Sendable {
    private static let origin = URL(string: "https://api.solcast.com.au")!
    private let apiKey: String
    private let transport: any SolcastTransport
    private let timeout: TimeInterval

    init(apiKey: String, transport: (any SolcastTransport)? = nil, timeout: TimeInterval = 30) {
        self.apiKey = apiKey
        self.timeout = Self.boundedTimeout(timeout)
        self.transport = transport ?? URLSessionSolcastTransport(timeout: self.timeout)
    }

    func discoverSites() async throws -> [SolcastSite] {
        let data = try await get(path: "/rooftop_sites")
        do { return try JSONDecoder().decode(SolcastSitesResponse.self, from: data).sites }
        catch { throw SolcastClientError.decodingFailure }
    }

    func fetchForecast(resourceID: String) async throws -> [SolcastForecastPoint] {
        guard Self.isSafeResourceID(resourceID) else { throw SolcastClientError.invalidResourceID }
        let data = try await get(path: "/rooftop_sites/\(resourceID)/forecasts")
        do { return try JSONDecoder().decode(SolcastForecastResponse.self, from: data).forecasts }
        catch { throw SolcastClientError.decodingFailure }
    }

    private func get(path: String) async throws -> Data {
        var components = URLComponents(url: Self.origin.appending(path: path), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "format", value: "json")]
        guard let url = components?.url else { throw SolcastClientError.invalidResponse }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do { (data, response) = try await transport.data(for: request) }
        catch { throw SolcastClientError.transportFailure }
        guard let http = response as? HTTPURLResponse,
              http.url?.scheme == "https", http.url?.host == "api.solcast.com.au" else {
            throw SolcastClientError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw SolcastClientError.httpStatus(statusCode: http.statusCode, retryAfter: Self.retryAfter(from: http))
        }
        return data
    }

    private static func retryAfter(from response: HTTPURLResponse) -> SolcastRetryAfter? {
        guard let value = response.value(forHTTPHeaderField: "Retry-After")?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        if value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
           let seconds = TimeInterval(value), seconds.isFinite {
            return .delay(seconds: seconds)
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
        formatter.isLenient = false
        guard let date = formatter.date(from: value) else { return nil }
        return .date(date)
    }

    private static func isSafeResourceID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 200 && value.utf8.allSatisfy {
            ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95
        }
    }

    private static func boundedTimeout(_ timeout: TimeInterval) -> TimeInterval {
        guard timeout.isFinite else { return timeout == .infinity ? 60 : timeout == -.infinity ? 1 : 30 }
        return min(max(timeout, 1), 60)
    }
}
