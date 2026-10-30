import Foundation

protocol ForecastSolarTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

/// No cookies, no cache, no redirects: the public API needs no identity and gets none.
private struct URLSessionForecastSolarTransport: ForecastSolarTransport {
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

enum ForecastSolarClientError: Error, Equatable {
    case transportFailure
    case invalidResponse
    case decodingFailure
    /// When the next request may be sent. Always set by the client, which falls back to an hour.
    case rateLimited(retryAfter: Date?)
    case httpStatus(Int)
}

struct ForecastSolarClient: Sendable {
    static let host = "api.forecast.solar"
    static let defaultDeferral: TimeInterval = 60 * 60
    private let transport: any ForecastSolarTransport
    private let timeout: TimeInterval
    private let clock: any SolarForecastClock

    init(
        transport: (any ForecastSolarTransport)? = nil,
        timeout: TimeInterval = 30,
        clock: any SolarForecastClock = SystemSolarForecastClock()
    ) {
        self.timeout = timeout.isFinite ? min(max(timeout, 1), 60) : 30
        self.transport = transport ?? URLSessionForecastSolarTransport(timeout: self.timeout)
        self.clock = clock
    }

    func estimate(location: SolarHomeLocation, plane: SolarLayoutPlane) async throws -> ForecastSolarPlaneEstimate {
        guard location.isValid, plane.isValid, let url = Self.url(location: location, plane: plane) else {
            throw ForecastSolarClientError.invalidResponse
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do { (data, response) = try await transport.data(for: request) } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw ForecastSolarClientError.transportFailure
        }
        guard let http = response as? HTTPURLResponse, http.url?.scheme == "https", http.url?.host == Self.host else {
            throw ForecastSolarClientError.invalidResponse
        }
        if http.statusCode == 429 {
            throw ForecastSolarClientError.rateLimited(retryAfter: retryAfter(http, body: data))
        }
        guard (200 ..< 300).contains(http.statusCode) else {
            throw ForecastSolarClientError.httpStatus(http.statusCode)
        }
        return try ForecastSolarPlaneEstimate.decode(data)
    }

    static func url(location: SolarHomeLocation, plane: SolarLayoutPlane) -> URL? {
        let tilt = min(max(Int(plane.tilt.rounded()), 0), 90)
        let azimuth = ForecastSolarForecast.forecastSolarAzimuth(compass: plane.azimuth)
        let path = [
            "estimate",
            String(format: "%.2f", location.latitude),
            String(format: "%.2f", location.longitude),
            String(tilt),
            String(azimuth),
            String(format: "%.2f", plane.dcKwp)].joined(separator: "/")
        return URL(string: "https://\(host)/\(path)")
    }

    /// The later of `Retry-After` and the body's reset. A spent quota with only a period
    /// defers for that period from now; a period is never read as a reset time.
    private func retryAfter(_ response: HTTPURLResponse, body: Data) -> Date {
        let now = clock.now()
        var candidates: [Date] = []
        if let header = response.value(forHTTPHeaderField: "Retry-After") {
            candidates += [Self.retryAfterHeader(header, now: now)].compactMap(\.self)
        }
        if let limit = try? JSONDecoder().decode(RateLimitBody.self, from: body).message.ratelimit {
            if let retryAt = limit.retryAt.flatMap(Self.isoDate) { candidates.append(retryAt) }
            if limit.remaining == 0, let period = limit.period, period.isFinite, period > 0 {
                candidates.append(now.addingTimeInterval(period))
            }
        }
        guard let latest = candidates.max(), latest > now else { return now.addingTimeInterval(Self.defaultDeferral) }
        return latest
    }

    private static func retryAfterHeader(_ value: String, now: Date) -> Date? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, trimmed.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }), let seconds = TimeInterval(trimmed) {
            return now.addingTimeInterval(seconds)
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
        formatter.isLenient = false
        return formatter.date(from: trimmed)
    }

    private static func isoDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}

private struct RateLimitBody: Decodable {
    let message: RateLimitMessage
}

private struct RateLimitMessage: Decodable {
    let ratelimit: RateLimit?
}

private struct RateLimit: Decodable {
    let period: TimeInterval?
    let remaining: Int?
    let retryAt: String?

    enum CodingKeys: String, CodingKey {
        case period, remaining
        case retryAt = "retry-at"
    }
}
