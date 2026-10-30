import Foundation

protocol OpenMeteoTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

private struct URLSessionOpenMeteoTransport: OpenMeteoTransport {
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
        configuration.allowsConstrainedNetworkAccess = false
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration, delegate: RedirectRejectingDelegate(), delegateQueue: nil)
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await session.data(for: request)
    }
}

enum OpenMeteoClientError: Error, Equatable {
    case transportFailure
    case invalidResponse
    case decodingFailure
    case rateLimited(retryAfter: Date?)
    case httpStatus(Int)
}

/// Downloads weather only. Panel geometry and production history stay on the phone.
struct OpenMeteoClient: Sendable {
    static let host = "api.open-meteo.com"
    static let defaultDeferral: TimeInterval = 3600
    private let transport: any OpenMeteoTransport
    private let clock: any SolarForecastClock
    private let timeout: TimeInterval

    init(
        transport: (any OpenMeteoTransport)? = nil,
        timeout: TimeInterval = 15,
        clock: any SolarForecastClock = SystemSolarForecastClock()
    ) {
        self.timeout = timeout.isFinite ? min(max(timeout, 1), 30) : 15
        self.transport = transport ?? URLSessionOpenMeteoTransport(timeout: self.timeout)
        self.clock = clock
    }

    func forecast(location: SolarHomeLocation) async throws -> OpenMeteoWeather {
        guard location.isValid, let url = Self.url(location: location) else {
            throw OpenMeteoClientError.invalidResponse
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpShouldHandleCookies = false
        request.allowsConstrainedNetworkAccess = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport.data(for: request)
            try Task.checkCancellation()
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            throw OpenMeteoClientError.transportFailure
        }
        guard let http = response as? HTTPURLResponse, http.url?.scheme == "https", http.url?.host == Self.host else {
            throw OpenMeteoClientError.invalidResponse
        }
        if http.statusCode == 429 {
            throw OpenMeteoClientError.rateLimited(retryAfter: retryAfter(http))
        }
        guard (200 ..< 300).contains(http.statusCode) else { throw OpenMeteoClientError.httpStatus(http.statusCode) }
        guard data.count <= 1_000_000 else { throw OpenMeteoClientError.invalidResponse }
        do { return try JSONDecoder().decode(OpenMeteoWeather.self, from: data) } catch {
            throw OpenMeteoClientError.decodingFailure
        }
    }

    static func url(location: SolarHomeLocation) -> URL? {
        var url = URLComponents()
        url.scheme = "https"
        url.host = host
        url.path = "/v1/forecast"
        let locale = Locale(identifier: "en_US_POSIX")
        url.queryItems = [
            URLQueryItem(name: "latitude", value: String(format: "%.2f", locale: locale, location.latitude)),
            URLQueryItem(name: "longitude", value: String(format: "%.2f", locale: locale, location.longitude)),
            URLQueryItem(name: "hourly", value: "shortwave_radiation,direct_normal_irradiance,diffuse_radiation"),
            URLQueryItem(name: "timezone", value: "GMT"),
            URLQueryItem(name: "timeformat", value: "unixtime"),
            URLQueryItem(name: "past_days", value: "1"),
            URLQueryItem(name: "forecast_days", value: "3")]
        return url.url
    }

    private func retryAfter(_ response: HTTPURLResponse) -> Date {
        let now = clock.now()
        guard let header = response.value(forHTTPHeaderField: "Retry-After") else {
            return now.addingTimeInterval(Self.defaultDeferral)
        }
        if let seconds = Double(header), seconds.isFinite, seconds >= 0 {
            return now.addingTimeInterval(max(seconds, 1))
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .gmt
        formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss z"
        let deadline = formatter.date(from: header) ?? now.addingTimeInterval(Self.defaultDeferral)
        return max(deadline, now.addingTimeInterval(1))
    }
}
