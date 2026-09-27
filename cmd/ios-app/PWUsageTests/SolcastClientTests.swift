import Foundation
import Testing
@testable import PWUsage

@Suite("Solcast Client Tests", .serialized)
struct SolcastClientTests {
    @Test("Decodes discovery sites with resource IDs, tags, and names")
    func decodesDiscoverySites() throws {
        let data = Data(#"{"sites":[{"resource_id":"site-abc_123","name":"Roof array","tags":["East","residential"]}]}"#.utf8)
        let response = try JSONDecoder().decode(SolcastSitesResponse.self, from: data)
        #expect(response.sites == [SolcastSite(resourceID: "site-abc_123", name: "Roof array", tags: ["East", "residential"])])
    }

    @Test("Decodes fractional and whole-second UTC forecast timestamps and optional percentiles")
    func decodesForecastTimestampsAndOptionalPercentiles() throws {
        let data = Data(#"{"forecasts":[{"period_end":"2026-09-27T12:30:00.125Z","period":"PT30M","pv_estimate":4.0,"pv_estimate10":3.1},{"period_end":"2026-09-27T13:00:00+00:00","period":"PT30M","pv_estimate":0.0}]}"#.utf8)
        let response = try JSONDecoder().decode(SolcastForecastResponse.self, from: data)
        #expect(response.forecasts.count == 2)
        #expect(response.forecasts[0].periodEnd == ISO8601DateFormatter.parse("2026-09-27T12:30:00.125Z"))
        #expect(response.forecasts[0].periodDuration == 1800)
        #expect(response.forecasts[0].pvEstimateKw == 4)
        #expect(response.forecasts[0].pvEstimate10Kw == 3.1)
        #expect(response.forecasts[0].pvEstimate90Kw == nil)
        #expect(response.forecasts[1].periodEnd == ISO8601DateFormatter.parse("2026-09-27T13:00:00+00:00"))
        #expect(response.forecasts[1].pvEstimateKw == 0)
    }

    @Test("Sends bearer authentication to fixed discovery and forecast endpoints")
    func sendsAuthenticatedRequestsToFixedEndpoints() async throws {
        let transport = RecordingSolcastTransport { request in
            let body: String
            if request.url?.path == "/rooftop_sites" { body = #"{"sites":[]}"# }
            else { body = #"{"forecasts":[]}"# }
            return (Data(body.utf8), HTTPURLResponse(url: try #require(request.url), statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let client = SolcastClient(apiKey: "synthetic-key", transport: transport)
        _ = try await client.discoverSites()
        _ = try await client.fetchForecast(resourceID: "site-abc_123")
        let requests = transport.requests
        #expect(requests.count == 2)
        #expect(requests[0].url?.absoluteString == "https://api.solcast.com.au/rooftop_sites?format=json")
        #expect(requests[1].url?.absoluteString == "https://api.solcast.com.au/rooftop_sites/site-abc_123/forecasts?format=json")
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic-key" })
        #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Cookie") == nil })
    }

    @Test("Rejects resource IDs that could escape their single path component")
    func rejectsUnsafeResourceIDs() async {
        let transport = RecordingSolcastTransport { _ in throw URLError(.unsupportedURL) }
        let client = SolcastClient(apiKey: "synthetic-key", transport: transport)
        await #expect(throws: SolcastClientError.invalidResourceID) {
            _ = try await client.fetchForecast(resourceID: "../other?key=secret")
        }
        #expect(transport.requests.isEmpty)
    }

    @Test("Maps provider errors without exposing response bodies")
    func mapsProviderErrorsWithoutBody() async throws {
        let transport = RecordingSolcastTransport { request in
            (Data(#"{"error":"private provider detail"}"#.utf8), HTTPURLResponse(url: try #require(request.url), statusCode: 429, httpVersion: nil, headerFields: nil)!)
        }
        let client = SolcastClient(apiKey: "synthetic-key", transport: transport)
        await #expect(throws: SolcastClientError.httpStatus(statusCode: 429, retryAfter: nil)) {
            _ = try await client.discoverSites()
        }
    }

    @Test("Parses retry-after delta seconds without retaining response headers")
    func parsesRetryAfterDeltaSeconds() async {
        let error = await providerError(status: 429, retryAfter: "120")
        #expect(error == .httpStatus(statusCode: 429, retryAfter: .delay(seconds: 120)))
    }

    @Test("Parses retry-after HTTP date")
    func parsesRetryAfterHTTPDate() async {
        let error = await providerError(status: 429, retryAfter: "Sun, 27 Sep 2026 18:00:00 GMT")
        #expect(error == .httpStatus(statusCode: 429, retryAfter: .date(Date(timeIntervalSince1970: 1790532000))))
    }

    @Test("Ignores absent or malformed retry-after values and retains the HTTP status")
    func ignoresInvalidRetryAfterValues() async {
        #expect(await providerError(status: 429, retryAfter: nil) == .httpStatus(statusCode: 429, retryAfter: nil))
        #expect(await providerError(status: 429, retryAfter: "not-a-delay") == .httpStatus(statusCode: 429, retryAfter: nil))
        #expect(await providerError(status: 401, retryAfter: nil) == .httpStatus(statusCode: 401, retryAfter: nil))
        #expect(await providerError(status: 401, retryAfter: "120") == .httpStatus(statusCode: 401, retryAfter: .delay(seconds: 120)))
    }

    @Test("Applies the bounded request timeout to every request")
    func appliesBoundedRequestTimeout() async throws {
        let transport = RecordingSolcastTransport { request in
            (Data(#"{"sites":[]}"#.utf8), HTTPURLResponse(url: try #require(request.url), statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        for timeout in [0.1, 500, Double.nan, Double.infinity, -Double.infinity] {
            _ = try await SolcastClient(apiKey: "synthetic-key", transport: transport, timeout: timeout).discoverSites()
        }
        #expect(transport.requests.map(\.timeoutInterval) == [1, 60, 30, 60, 1])
    }

    @Test("Rejects missing and nonfinite forecast power")
    func rejectsMissingAndNonfinitePower() {
        let missing = Data(#"{"forecasts":[{"period_end":"2026-09-27T12:30:00Z","period":"PT30M"}]}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(SolcastForecastResponse.self, from: missing) }
        let nonfinite = Data(#"{"forecasts":[{"period_end":"2026-09-27T12:30:00Z","period":"PT30M","pv_estimate":1e999}]}"#.utf8)
        #expect(throws: (any Error).self) { try JSONDecoder().decode(SolcastForecastResponse.self, from: nonfinite) }
    }

    private func providerError(status: Int, retryAfter: String?) async -> SolcastClientError? {
        let transport = RecordingSolcastTransport { request in
            let headers = retryAfter.map { ["Retry-After": $0] }
            return (Data(#"{"private":"body must not escape"}"#.utf8), HTTPURLResponse(url: try #require(request.url), statusCode: status, httpVersion: nil, headerFields: headers)!)
        }
        do {
            _ = try await SolcastClient(apiKey: "synthetic-key", transport: transport).discoverSites()
            return nil
        } catch let error as SolcastClientError {
            return error
        } catch {
            return nil
        }
    }
}

private final class RecordingSolcastTransport: SolcastTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recordedRequests: [URLRequest] = []
    private let handler: (URLRequest) async throws -> (Data, URLResponse)

    init(handler: @escaping (URLRequest) async throws -> (Data, URLResponse)) { self.handler = handler }

    var requests: [URLRequest] {
        lock.withLock { recordedRequests }
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        lock.withLock { recordedRequests.append(request) }
        return try await handler(request)
    }
}

private extension ISO8601DateFormatter {
    static func parse(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = value.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
