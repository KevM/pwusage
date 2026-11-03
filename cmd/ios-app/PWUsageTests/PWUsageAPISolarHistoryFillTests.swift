import Foundation
@testable import PWUsage
import Testing

extension PWUsageAPITests {
    static func fillResponse(
        _ request: URLRequest, status: Int, headers: [String: String] = [:]
    ) throws -> HTTPURLResponse {
        let url = try #require(request.url)
        return try #require(HTTPURLResponse(
            url: url, statusCode: status, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"].merging(headers) { $1 }))
    }

    static let fillDayJSON = """
    {"day":"2026-10-24","dayStart":"2026-10-24T00:00:00.000Z","status":"complete",
     "fetchedAt":"2026-10-27T12:00:00.000Z","solarWh":[5\(String(repeating: ",null", count: 287))]}
    """

    @Test("Solar history fill posts the slice and decodes its status, bound and days")
    func solarHistoryFillTransport() async throws {
        var recorded: (URLRequest, Data)?
        StubURLProtocol.requestHandler = { request in
            recorded = (request, try Self.bodyData(from: request))
            let json = """
            {"version":1,"enabled":true,"timeZone":"UTC","status":"partial","historyStart":"2024-03-10",
             "days":[\(Self.fillDayJSON)]}
            """
            return (try Self.fillResponse(request, status: 200), Data(json.utf8))
        }
        let response = try await api.fillSolarHistory(siteID: "site-1", from: "2026-10-24", days: 3)
        guard case .enabled(let fill) = response else {
            Issue.record("Expected an enabled fill")
            return
        }
        #expect(fill.status == .partial)
        #expect(fill.historyStart == "2024-03-10")
        #expect(fill.timeZone.secondsFromGMT() == 0)
        #expect(fill.days.map(\.day) == ["2026-10-24"])
        #expect(fill.days.first?.solarWh.first == 5)

        let (request, body) = try #require(recorded)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/api/mobile/solar-history")
        let sent = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        #expect(sent?["siteId"] as? String == "site-1")
        #expect(sent?["from"] as? String == "2026-10-24")
        #expect(sent?["days"] as? Int == 3)
    }

    @Test("Solar history fill decodes a disabled site")
    func solarHistoryFillDisabled() async throws {
        StubURLProtocol.requestHandler = { request in
            (try Self.fillResponse(request, status: 200), Data(#"{"version":1,"enabled":false}"#.utf8))
        }
        #expect(try await api.fillSolarHistory(siteID: "site-1", from: "2026-10-24", days: 1) == .disabled)
    }

    @Test("A Tesla throttle keeps the server's retry deadline and whether it was a fallback")
    func solarHistoryFillThrottle() async throws {
        StubURLProtocol.requestHandler = { request in
            let body = """
            {"error":"Tesla is limiting requests","code":"TESLA_RATE_LIMITED",
             "retryAt":"2026-10-27T19:30:00.000Z","retryAfterSource":"fallback"}
            """
            return (try Self.fillResponse(request, status: 529, headers: ["Retry-After": "3600"]), Data(body.utf8))
        }
        let retryAt = try #require(ISO8601DateFormatter().date(from: "2026-10-27T19:30:00Z"))
        await #expect(throws: MobileSolarHistoryFillError.rateLimited(retryAt: retryAt, isFallback: true)) {
            try await api.fillSolarHistory(siteID: "site-1", from: "2026-10-24", days: 3)
        }
    }

    @Test("A throttle without a readable body falls back to Retry-After")
    func solarHistoryFillThrottleHeaderOnly() async throws {
        StubURLProtocol.requestHandler = { request in
            (try Self.fillResponse(request, status: 529, headers: ["Retry-After": "120"]), Data())
        }
        let before = Date()
        do {
            _ = try await api.fillSolarHistory(siteID: "site-1", from: "2026-10-24", days: 3)
            Issue.record("Expected a throttle")
        } catch MobileSolarHistoryFillError.rateLimited(let retryAt, let isFallback) {
            #expect(!isFallback)
            #expect(retryAt.timeIntervalSince(before) >= 119)
            #expect(retryAt.timeIntervalSince(before) <= 125)
        }
    }

    @Test("A throttle with no deadline at all waits the documented fallback")
    func solarHistoryFillThrottleNoDeadline() async throws {
        StubURLProtocol.requestHandler = { request in (try Self.fillResponse(request, status: 529), Data()) }
        let before = Date()
        do {
            _ = try await api.fillSolarHistory(siteID: "site-1", from: "2026-10-24", days: 3)
            Issue.record("Expected a throttle")
        } catch MobileSolarHistoryFillError.rateLimited(let retryAt, let isFallback) {
            #expect(isFallback)
            #expect(retryAt.timeIntervalSince(before) >= 59)
        }
    }

    @Test("A Tesla token backoff and a reconnect are distinct fill errors")
    func solarHistoryFillTeslaStates() async throws {
        StubURLProtocol.requestHandler = { request in
            (try Self.fillResponse(request, status: 503, headers: ["Retry-After": "120"]),
             Data(#"{"code":"TESLA_REFRESH_BACKOFF","error":"Tesla is temporarily unavailable."}"#.utf8))
        }
        do {
            _ = try await api.fillSolarHistory(siteID: "site-1", from: "2026-10-24", days: 3)
            Issue.record("Expected a backoff")
        } catch MobileSolarHistoryFillError.teslaUnavailable(let retryAt) {
            #expect(retryAt.timeIntervalSinceNow > 100)
        }

        StubURLProtocol.requestHandler = { request in
            (try Self.fillResponse(request, status: 409), Data(#"{"code":"TESLA_CONNECTION_REQUIRED"}"#.utf8))
        }
        await #expect(throws: MobileSolarHistoryFillError.teslaReconnectRequired) {
            try await api.fillSolarHistory(siteID: "site-1", from: "2026-10-24", days: 3)
        }

        StubURLProtocol.requestHandler = { request in (try Self.fillResponse(request, status: 500), Data()) }
        await #expect(throws: PWUsageAPIError.recoverableServerError(statusCode: 500)) {
            try await api.fillSolarHistory(siteID: "site-1", from: "2026-10-24", days: 3)
        }
    }
}
