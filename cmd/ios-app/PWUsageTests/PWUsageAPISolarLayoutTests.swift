import Foundation
@testable import PWUsage
import Testing

/// Solar layout transport, in the serialized API suite because it shares `StubURLProtocol`.
extension PWUsageAPITests {
    @Test("Solar layout and actuals use the mobile routes with the site query")
    func solarLayoutTransport() async throws {
        StubURLProtocol.requestHandler = { request in
            let url = try #require(request.url)
            let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
            #expect(components.queryItems == [URLQueryItem(name: "siteId", value: "site-1")])
            #expect(request.httpMethod == "GET")
            switch components.path {
            case "/api/mobile/solar-layout", "/api/mobile/solar-actuals":
                return (try Self.response(request, status: 200), Data(#"{"version":1,"enabled":false}"#.utf8))
            default:
                throw URLError(.unsupportedURL)
            }
        }
        #expect(try await api.fetchSolarLayout(siteID: "site-1") == .disabled)
        #expect(try await api.fetchSolarActuals(siteID: "site-1") == .disabled)
    }

    @Test("A version 2 layout or actuals response is an invalid response")
    func solarLayoutUnsupportedVersion() async throws {
        StubURLProtocol.requestHandler = { request in
            (try Self.response(request, status: 200), Data(#"{"version":2,"enabled":false}"#.utf8))
        }
        await #expect(throws: PWUsageAPIError.invalidResponse) { try await api.fetchSolarLayout(siteID: "site-1") }
        await #expect(throws: PWUsageAPIError.invalidResponse) { try await api.fetchSolarActuals(siteID: "site-1") }
    }

    @Test("Posting a location sends coordinates rounded to two decimals and accepts an empty 204")
    func postSolarLocation() async throws {
        var captured: (URLRequest, Data)?
        StubURLProtocol.requestHandler = { request in
            captured = (request, try Self.bodyData(from: request))
            return (try Self.response(request, status: 204), Data())
        }
        try await api.postSolarLocation(siteID: "site-1", latitude: 43.39321, longitude: -87.87654)
        let (request, body) = try #require(captured)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/mobile/solar-layout")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["siteId"] as? String == "site-1")
        #expect(json["latitude"] as? Double == 43.39)
        #expect(json["longitude"] as? Double == -87.88)
    }

    @Test("Posting a location keeps the existing HTTP error mapping", arguments: [400, 401, 403])
    func postSolarLocationErrors(status: Int) async throws {
        let expected = status == 401
            ? PWUsageAPIError.signInRequired
            : .requestRejected(statusCode: status, message: nil)
        StubURLProtocol.requestHandler = { request in (try Self.response(request, status: status), Data()) }
        await #expect(throws: expected) {
            try await self.api.postSolarLocation(siteID: "site-1", latitude: 1, longitude: 2)
        }
    }
}
